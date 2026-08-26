import { useEffect, useRef, useState } from 'react';
import type {
  DynamicTableDdlJobAcceptedDto,
  DynamicTableDdlJobDto,
} from '@flexi/shared-types';
import { ApiError } from '../../lib/api-client';

export const MAX_POLL_ATTEMPTS = 30;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_JOB_ERROR_LENGTH = 300;

export type DdlJobSubmissionState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'polling'; jobId: string; attempt: number }
  /**
   * `detail` carries the failure reason the backend recorded on the DDL job.
   * Only the code is guaranteed: a request that never reached a job, or a job
   * that failed without a message, leaves it undefined.
   */
  | { status: 'error'; code: string; detail?: string };

/** Enqueues the DDL job this submission will then poll to completion. */
export type EnqueueDdlJob = (
  signal: AbortSignal,
) => Promise<DynamicTableDdlJobAcceptedDto>;

export interface UseDdlJobSubmissionOptions {
  getJob: (
    jobId: string,
    signal?: AbortSignal,
  ) => Promise<DynamicTableDdlJobDto>;
  onCompleted?: () => void;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

export interface UseDdlJobSubmission {
  state: DdlJobSubmissionState;
  /** True while a job is being enqueued or polled, for disabling the form. */
  isBusy: boolean;
  /**
   * Whether a submission still owns the abort controller. Read it before
   * validating a resubmit: `state` lags a completed job that resolved through
   * `onCompleted`, so it cannot answer this on its own.
   */
  isInFlight: () => boolean;
  submit: (enqueue: EnqueueDdlJob) => Promise<void>;
  /** Drops any terminal state so the form reads as untouched again. */
  reset: () => void;
}

function errorCode(error: unknown): string {
  return error instanceof ApiError && /^[A-Z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : 'REQUEST_FAILED';
}

/**
 * The reason a DDL job recorded for its failure, ready to render. It is a raw
 * driver/worker message rather than a curated string, so it is collapsed to a
 * single line and capped -- a multi-line Postgres error would otherwise push
 * the form off screen.
 */
function jobErrorDetail(error: string | null): string | undefined {
  const detail = (error ?? '').replace(/\s+/g, ' ').trim();
  if (!detail) return undefined;
  return detail.length > MAX_JOB_ERROR_LENGTH
    ? `${detail.slice(0, MAX_JOB_ERROR_LENGTH).trimEnd()}…`
    : detail;
}

/**
 * Owns the "enqueue a DDL job, then poll it until it settles" lifecycle shared
 * by every dynamic-table form: table/field DDL is asynchronous, so the request
 * that starts it only ever returns a job id. Callers keep their own validation
 * and payload building and hand the enqueue call to {@link UseDdlJobSubmission.submit}.
 *
 * Polling is a bounded loop rather than an interval so a slow response cannot
 * stack requests, and it is aborted on unmount and on every resubmit so a
 * superseded job can never settle onto the current form.
 */
export function useDdlJobSubmission({
  getJob,
  onCompleted,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxPollAttempts = MAX_POLL_ATTEMPTS,
}: UseDdlJobSubmissionOptions): UseDdlJobSubmission {
  const [state, setState] = useState<DdlJobSubmissionState>({ status: 'idle' });
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const inFlightRef = useRef(false);

  useEffect(
    () => () => {
      mountedRef.current = false;
      inFlightRef.current = false;
      controllerRef.current?.abort();
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const pollJob = async (jobId: string, controller: AbortController) => {
    const limit = Math.max(1, Math.floor(maxPollAttempts));
    for (let attempt = 1; attempt <= limit; attempt += 1) {
      if (!mountedRef.current || controller.signal.aborted) return;
      try {
        const job = await getJob(jobId, controller.signal);
        if (!mountedRef.current || controller.signal.aborted) return;

        if (job.status === 'completed') {
          inFlightRef.current = false;
          onCompleted?.();
          return;
        }
        if (job.status === 'failed') {
          inFlightRef.current = false;
          setState({
            status: 'error',
            code: 'DDL_JOB_FAILED',
            detail: jobErrorDetail(job.error),
          });
          return;
        }
        setState({ status: 'polling', jobId, attempt });
      } catch (error) {
        if (!controller.signal.aborted && mountedRef.current) {
          inFlightRef.current = false;
          setState({ status: 'error', code: errorCode(error) });
        }
        return;
      }

      if (attempt < limit) {
        await new Promise<void>((resolve) => {
          timerRef.current = setTimeout(resolve, Math.max(0, pollIntervalMs));
        });
      }
    }

    if (mountedRef.current && !controller.signal.aborted) {
      inFlightRef.current = false;
      setState({ status: 'error', code: 'POLLING_TIMEOUT' });
    }
  };

  const submit = async (enqueue: EnqueueDdlJob) => {
    const controller = new AbortController();
    controllerRef.current?.abort();
    controllerRef.current = controller;
    inFlightRef.current = true;
    setState({ status: 'submitting' });
    try {
      const accepted = await enqueue(controller.signal);
      if (!mountedRef.current || controller.signal.aborted) return;
      setState({ status: 'polling', jobId: accepted.jobId, attempt: 0 });
      await pollJob(accepted.jobId, controller);
    } catch (error) {
      if (!controller.signal.aborted && mountedRef.current) {
        inFlightRef.current = false;
        setState({ status: 'error', code: errorCode(error) });
      }
    }
  };

  return {
    state,
    isBusy: state.status === 'submitting' || state.status === 'polling',
    isInFlight: () => inFlightRef.current,
    submit,
    reset: () => setState({ status: 'idle' }),
  };
}
