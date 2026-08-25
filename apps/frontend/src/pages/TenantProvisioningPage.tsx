import { useCallback, useEffect, useState } from 'react';
import type {
  TenantOnboardingAttemptStatusDto,
  TenantOnboardingAttemptStatus,
  TenantOnboardingStepOutcomeDto,
} from '@flexi/shared-types';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import {
  canReadTenants,
  SYSTEM_TENANTS_READ_PERMISSION,
} from '../auth/permissions';
import { Badge, Button, Card, Icon, PageHeader } from '../components/ui';
import { apiGet } from '../lib/api-client';
import { PermissionDeniedPage } from './PermissionDeniedPage';

const TERMINAL_STATUSES = new Set<TenantOnboardingAttemptStatus>([
  'succeeded',
  'failed',
  'failed-needs-manual-cleanup',
]);

export interface TenantProvisioningPageProps {
  loadAttempt?: (
    attemptId: string,
    signal?: AbortSignal,
  ) => Promise<TenantOnboardingAttemptStatusDto>;
  initialPollDelayMs?: number;
  maxPollDelayMs?: number;
}

function defaultLoadAttempt(
  attemptId: string,
  signal?: AbortSignal,
): Promise<TenantOnboardingAttemptStatusDto> {
  return apiGet<TenantOnboardingAttemptStatusDto>(
    `/v1/super-admin/tenants/onboarding-attempts/${encodeURIComponent(attemptId)}`,
    { signal },
  );
}

function isTerminal(status: TenantOnboardingAttemptStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function statusTone(
  status: TenantOnboardingAttemptStatus,
): 'success' | 'warning' | 'danger' | 'neutral' {
  if (status === 'succeeded') return 'success';
  if (status === 'failed' || status === 'failed-needs-manual-cleanup') {
    return 'danger';
  }
  if (status === 'provisioning') return 'warning';
  return 'neutral';
}

function stepTone(
  status: TenantOnboardingStepOutcomeDto['status'],
): 'success' | 'warning' | 'danger' {
  return status === 'succeeded'
    ? 'success'
    : status === 'failed'
      ? 'danger'
      : 'warning';
}

function statusIcon(status: TenantOnboardingAttemptStatus): string {
  if (status === 'succeeded') return 'check_circle';
  if (status === 'failed' || status === 'failed-needs-manual-cleanup') {
    return 'error';
  }
  return status === 'provisioning' ? 'progress_activity' : 'schedule';
}

function formatDate(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(date);
}

export function TenantProvisioningPage({
  loadAttempt = defaultLoadAttempt,
  initialPollDelayMs = 1_000,
  maxPollDelayMs = 8_000,
}: TenantProvisioningPageProps = {}) {
  const { currentUser } = useAuth();
  const { attemptId } = useParams<{ attemptId: string }>();
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [attempt, setAttempt] =
    useState<TenantOnboardingAttemptStatusDto | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);

  const retryLoad = useCallback(() => setRetryKey((value) => value + 1), []);

  useEffect(() => {
    if (!attemptId) return;

    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let delay = Math.max(0, initialPollDelayMs);

    const poll = async () => {
      setLoadError(false);
      try {
        const nextAttempt = await loadAttempt(attemptId, controller.signal);
        if (cancelled) return;

        setAttempt(nextAttempt);
        if (!isTerminal(nextAttempt.status)) {
          timer = setTimeout(poll, delay);
          delay = Math.min(Math.max(delay * 2, 1), maxPollDelayMs);
        }
      } catch (error) {
        if (
          cancelled ||
          (error instanceof DOMException && error.name === 'AbortError')
        ) {
          return;
        }
        setLoadError(true);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [attemptId, initialPollDelayMs, loadAttempt, maxPollDelayMs, retryKey]);

  if (!canReadTenants(currentUser)) {
    return (
      <PermissionDeniedPage
        permissionCode={SYSTEM_TENANTS_READ_PERMISSION}
        action={{
          labelKey: 'provisioning.backToTenants',
          onClick: () => navigate('/tenants'),
        }}
      />
    );
  }

  if (!attemptId) {
    return (
      <PermissionDeniedPage permissionCode={SYSTEM_TENANTS_READ_PERMISSION} />
    );
  }

  const terminal = attempt && isTerminal(attempt.status);
  const title = attempt
    ? terminal
      ? t(`provisioning.terminal.${attempt.status}.title`)
      : t('provisioning.title')
    : t('provisioning.title');
  const description = attempt
    ? terminal
      ? t(`provisioning.terminal.${attempt.status}.description`)
      : t('provisioning.polling')
    : t('provisioning.loading');

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={
          <Button
            variant="secondary"
            icon="arrow_back"
            onClick={() => navigate('/tenants')}
          >
            {t('provisioning.backToTenants')}
          </Button>
        }
      />

      <div className="grid gap-md">
        {attempt && (
          <Card className="flex flex-wrap items-center justify-between gap-sm">
            <div className="flex items-center gap-sm">
              <Icon
                name={statusIcon(attempt.status)}
                className="text-primary"
              />
              <div>
                <p className="font-body-sm text-body-sm text-on-surface-variant">
                  {t('provisioning.attemptId')}
                </p>
                <code className="font-mono text-body-sm text-on-surface">
                  {attempt.id}
                </code>
              </div>
            </div>
            <Badge tone={statusTone(attempt.status)}>
              {t(`provisioning.status.${attempt.status}`)}
            </Badge>
          </Card>
        )}

        {loadError ? (
          <Card
            className="flex flex-wrap items-center justify-between gap-sm"
            role="alert"
          >
            <p className="text-body-sm text-on-surface">
              {t('provisioning.loadError')}
            </p>
            <Button
              size="sm"
              variant="secondary"
              icon="refresh"
              onClick={retryLoad}
            >
              {t('provisioning.retryLoad')}
            </Button>
          </Card>
        ) : null}

        {attempt ? (
          <Card>
            <div className="mb-md flex items-center justify-between gap-sm">
              <h2 className="font-headline-sm text-headline-sm text-on-surface">
                {t('provisioning.timeline.title')}
              </h2>
              {!terminal && (
                <Badge tone="warning" icon="progress_activity">
                  {t('provisioning.polling')}
                </Badge>
              )}
            </div>
            <ol
              className="grid gap-sm"
              aria-label={t('provisioning.timeline.label')}
            >
              {attempt.stepOutcomes.map((outcome) => (
                <li
                  className="flex items-start justify-between gap-sm rounded border border-outline-variant bg-surface-container-lowest p-sm"
                  key={`${outcome.step}:${outcome.occurredAt}`}
                >
                  <div className="flex items-start gap-sm">
                    <Icon
                      name={
                        outcome.status === 'succeeded'
                          ? 'check_circle'
                          : outcome.status === 'failed'
                            ? 'error'
                            : 'progress_activity'
                      }
                      className="mt-0.5 text-outline"
                    />
                    <div>
                      <p className="font-body-sm text-body-sm text-on-surface">
                        {t(`provisioning.steps.${outcome.step}`)}
                      </p>
                      <p className="font-body-sm text-body-sm text-on-surface-variant">
                        {formatDate(outcome.occurredAt, i18n.language)}
                      </p>
                    </div>
                  </div>
                  <Badge tone={stepTone(outcome.status)}>
                    {t(`provisioning.stepStatus.${outcome.status}`)}
                  </Badge>
                </li>
              ))}
            </ol>
          </Card>
        ) : !loadError ? (
          <Card className="flex items-center gap-sm" role="status">
            <Icon name="progress_activity" className="text-primary" />
            <span className="text-body-sm text-on-surface">
              {t('provisioning.loading')}
            </span>
          </Card>
        ) : null}

        {attempt?.status === 'failed-needs-manual-cleanup' && (
          <Card className="border-error-container bg-error-container">
            <h2 className="font-headline-sm text-headline-sm text-on-error-container">
              {t('provisioning.manualCleanup.title')}
            </h2>
            <p className="mt-xs text-body-sm text-on-error-container">
              {t('provisioning.manualCleanup.description')}
            </p>
          </Card>
        )}
      </div>
    </>
  );
}
