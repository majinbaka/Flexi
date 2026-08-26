import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ApiError } from '../../lib/api-client';
import { useDdlJobSubmission } from './use-ddl-job-submission';

function queuedJob(jobId: string) {
  return { jobId, status: 'pending' as const, error: null };
}

describe('useDdlJobSubmission', () => {
  it('polls a queued job until it completes', async () => {
    const getJob = vi
      .fn()
      .mockResolvedValueOnce(queuedJob('ddl-1'))
      .mockResolvedValueOnce({
        jobId: 'ddl-1',
        status: 'completed',
        error: null,
      });
    const onCompleted = vi.fn();
    const { result } = renderHook(() =>
      useDdlJobSubmission({ getJob, onCompleted, pollIntervalMs: 0 }),
    );

    await act(async () => {
      await result.current.submit(async () => ({ jobId: 'ddl-1' }));
    });

    expect(onCompleted).toHaveBeenCalledTimes(1);
    expect(getJob).toHaveBeenCalledTimes(2);
    expect(result.current.isInFlight()).toBe(false);
  });

  it('surfaces the reason a failed job recorded, collapsed to one line', async () => {
    const getJob = vi.fn().mockResolvedValue({
      jobId: 'ddl-1',
      status: 'failed',
      error: '  column "total"\n  cannot be cast  ',
    });
    const { result } = renderHook(() =>
      useDdlJobSubmission({ getJob, pollIntervalMs: 0 }),
    );

    await act(async () => {
      await result.current.submit(async () => ({ jobId: 'ddl-1' }));
    });

    expect(result.current.state).toEqual({
      status: 'error',
      code: 'DDL_JOB_FAILED',
      detail: 'column "total" cannot be cast',
    });
  });

  it('gives up once the attempt budget is spent', async () => {
    const getJob = vi.fn().mockResolvedValue(queuedJob('ddl-1'));
    const { result } = renderHook(() =>
      useDdlJobSubmission({ getJob, pollIntervalMs: 0, maxPollAttempts: 3 }),
    );

    await act(async () => {
      await result.current.submit(async () => ({ jobId: 'ddl-1' }));
    });

    expect(getJob).toHaveBeenCalledTimes(3);
    expect(result.current.state).toEqual({
      status: 'error',
      code: 'POLLING_TIMEOUT',
    });
  });

  it('keeps the API error code when the enqueue call itself is rejected', async () => {
    const { result } = renderHook(() =>
      useDdlJobSubmission({ getJob: vi.fn(), pollIntervalMs: 0 }),
    );

    await act(async () => {
      await result.current.submit(() => {
        throw new ApiError('TABLE_ALREADY_EXISTS', 'already exists');
      });
    });

    expect(result.current.state).toEqual({
      status: 'error',
      code: 'TABLE_ALREADY_EXISTS',
    });
  });

  it('falls back to REQUEST_FAILED for a non-API rejection', async () => {
    const { result } = renderHook(() =>
      useDdlJobSubmission({ getJob: vi.fn(), pollIntervalMs: 0 }),
    );

    await act(async () => {
      await result.current.submit(() => {
        throw new Error('network down');
      });
    });

    expect(result.current.state).toEqual({
      status: 'error',
      code: 'REQUEST_FAILED',
    });
  });

  it('aborts the previous submission so a superseded job cannot settle', async () => {
    const getJob = vi.fn().mockResolvedValue(queuedJob('ddl-2'));
    const signals: AbortSignal[] = [];
    let releaseFirst: () => void = () => {};
    const { result } = renderHook(() =>
      useDdlJobSubmission({ getJob, pollIntervalMs: 0, maxPollAttempts: 1 }),
    );

    let first: Promise<void> | undefined;
    await act(async () => {
      first = result.current.submit((signal) => {
        signals.push(signal);
        return new Promise((resolve) => {
          releaseFirst = () => resolve({ jobId: 'ddl-1' });
        });
      });
    });

    await act(async () => {
      await result.current.submit((signal) => {
        signals.push(signal);
        return Promise.resolve({ jobId: 'ddl-2' });
      });
    });

    expect(signals[0].aborted).toBe(true);
    expect(result.current.state).toEqual({
      status: 'error',
      code: 'POLLING_TIMEOUT',
    });

    // The superseded enqueue answering late must not restart its polling.
    await act(async () => {
      releaseFirst();
      await first;
    });

    expect(getJob).toHaveBeenCalledTimes(1);
    expect(getJob).toHaveBeenCalledWith('ddl-2', expect.anything());
    expect(result.current.state).toEqual({
      status: 'error',
      code: 'POLLING_TIMEOUT',
    });
  });

  it('parks a request for confirmation and locks the form without sending it', () => {
    const enqueue = vi.fn();
    const { result } = renderHook(() =>
      useDdlJobSubmission<{ edits: number }>({
        getJob: vi.fn(),
        pollIntervalMs: 0,
      }),
    );

    act(() => result.current.confirm({ edits: 2 }));

    expect(result.current.state).toEqual({
      status: 'confirming',
      request: { edits: 2 },
    });
    // Nothing is in flight yet, but the form is held: the parked request is a
    // snapshot of drafts the user still has to approve.
    expect(result.current.isBusy).toBe(false);
    expect(result.current.isLocked).toBe(true);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('drops a parked request when the submission moves on, not separately', async () => {
    const getJob = vi
      .fn()
      .mockResolvedValue({ jobId: 'ddl-1', status: 'completed', error: null });
    const { result } = renderHook(() =>
      useDdlJobSubmission<{ edits: number }>({ getJob, pollIntervalMs: 0 }),
    );

    act(() => result.current.confirm({ edits: 1 }));
    await act(async () => {
      await result.current.submit(async () => ({ jobId: 'ddl-1' }));
    });
    expect(result.current.state.status).not.toBe('confirming');

    act(() => result.current.confirm({ edits: 1 }));
    act(() => result.current.reset());

    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.isLocked).toBe(false);
  });

  it('drops a terminal state on reset', async () => {
    const { result } = renderHook(() =>
      useDdlJobSubmission({ getJob: vi.fn(), pollIntervalMs: 0 }),
    );

    await act(async () => {
      await result.current.submit(() => {
        throw new Error('network down');
      });
    });
    expect(result.current.state.status).toBe('error');

    act(() => result.current.reset());

    expect(result.current.state).toEqual({ status: 'idle' });
    expect(result.current.isBusy).toBe(false);
  });
});
