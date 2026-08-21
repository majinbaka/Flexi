import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import type { TenantSlugAvailabilityDto } from '@flexi/shared-types';
import {
  isTenantSlugFormatValid,
  validateTenantOnboardingInput,
  type TenantOnboardingValidationErrorCode,
  type TenantOnboardingPlan,
} from '@flexi/shared-types';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import {
  canOnboardTenants,
  SYSTEM_TENANTS_ONBOARD_PERMISSION,
} from '../auth/permissions';
import {
  Badge,
  Button,
  Card,
  Icon,
  Input,
  PageHeader,
  Select,
} from '../components/ui';
import { ApiError, apiGet } from '../lib/api-client';
import { PermissionDeniedPage } from './PermissionDeniedPage';

type Plan = '' | TenantOnboardingPlan;

interface OnboardingFormValues {
  tenantName: string;
  tenantSlug: string;
  firstAdminEmail: string;
  plan: Plan;
  notes: string;
}

type FieldName = keyof OnboardingFormValues;

type SlugAvailabilityState =
  | { status: 'idle'; slug: string }
  | { status: 'checking'; slug: string }
  | { status: 'available'; slug: string }
  | { status: 'unavailable'; slug: string }
  | { status: 'error'; slug: string; message: string };

type SubmitState = 'idle' | 'rechecking' | 'confirmed';

export interface TenantOnboardingPageProps {
  checkSlugAvailability?: (
    slug: string,
    signal?: AbortSignal,
  ) => Promise<TenantSlugAvailabilityDto>;
  preflightDelayMs?: number;
}

const INITIAL_VALUES: OnboardingFormValues = {
  tenantName: '',
  tenantSlug: '',
  firstAdminEmail: '',
  plan: '',
  notes: '',
};

function defaultCheckSlugAvailability(
  slug: string,
  signal?: AbortSignal,
): Promise<TenantSlugAvailabilityDto> {
  return apiGet<TenantSlugAvailabilityDto>(
    `/v1/super-admin/tenants/slug-availability?slug=${encodeURIComponent(
      slug,
    )}`,
    { signal },
  );
}

const VALIDATION_MESSAGE_KEYS: Record<
  TenantOnboardingValidationErrorCode,
  string
> = {
  TENANT_NAME_REQUIRED: 'onboarding.validation.tenantNameRequired',
  SLUG_REQUIRED: 'onboarding.validation.slugRequired',
  SLUG_FORMAT: 'onboarding.validation.slugFormat',
  EMAIL_REQUIRED: 'onboarding.validation.emailRequired',
  EMAIL_FORMAT: 'onboarding.validation.emailFormat',
  PLAN_REQUIRED: 'onboarding.validation.planRequired',
};

function OnboardingSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  const descriptionId = `${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')}-description`;

  return (
    <Card>
      <fieldset
        className="flex flex-col gap-md"
        aria-describedby={descriptionId}
      >
        <legend className="font-display-lg text-[18px] font-bold text-on-surface">
          {title}
        </legend>
        <p
          className="font-body-sm text-body-sm text-on-surface-variant"
          id={descriptionId}
        >
          {description}
        </p>
        {children}
      </fieldset>
    </Card>
  );
}

function TenantOnboardingForm({
  checkSlugAvailability = defaultCheckSlugAvailability,
  preflightDelayMs = 450,
}: TenantOnboardingPageProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [values, setValues] = useState<OnboardingFormValues>(INITIAL_VALUES);
  const [touched, setTouched] = useState<Partial<Record<FieldName, boolean>>>(
    {},
  );
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [slugAvailability, setSlugAvailability] =
    useState<SlugAvailabilityState>({ status: 'idle', slug: '' });
  const [submitState, setSubmitState] = useState<SubmitState>('idle');
  const slugRequestId = useRef(0);
  const mountedRef = useRef(true);
  const submitAbortControllerRef = useRef<AbortController | null>(null);

  const getValidationErrors = useCallback(
    (nextValues: OnboardingFormValues): Partial<Record<FieldName, string>> => {
      const errors: Partial<Record<FieldName, string>> = {};
      const validation = validateTenantOnboardingInput(nextValues);

      for (const [field, code] of Object.entries(validation) as Array<
        [FieldName, TenantOnboardingValidationErrorCode]
      >) {
        errors[field] = t(VALIDATION_MESSAGE_KEYS[code]);
      }

      return errors;
    },
    [t],
  );

  const validationErrors = useMemo(
    () => getValidationErrors(values),
    [getValidationErrors, values],
  );
  const trimmedSlug = values.tenantSlug.trim();
  const activeSlugAvailability: SlugAvailabilityState =
    slugAvailability.slug === trimmedSlug
      ? slugAvailability
      : { status: 'idle', slug: trimmedSlug };
  const isSubmitting = submitState === 'rechecking';

  const visibleError = (field: FieldName): string | undefined => {
    if (!touched[field] && !submitAttempted) {
      return undefined;
    }
    if (field === 'tenantSlug') {
      if (validationErrors.tenantSlug) {
        return validationErrors.tenantSlug;
      }
      if (
        activeSlugAvailability.status === 'unavailable' &&
        activeSlugAvailability.slug === trimmedSlug
      ) {
        return t('onboarding.validation.slugUnavailable');
      }
      if (
        activeSlugAvailability.status === 'error' &&
        activeSlugAvailability.slug === trimmedSlug
      ) {
        return activeSlugAvailability.message;
      }
    }
    return validationErrors[field];
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      submitAbortControllerRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    const slug = values.tenantSlug.trim();
    const requestId = slugRequestId.current + 1;
    slugRequestId.current = requestId;

    if (!slug || !isTenantSlugFormatValid(slug)) {
      return undefined;
    }

    const abortController = new AbortController();
    let cancelled = false;
    const timeoutId = window.setTimeout(() => {
      if (cancelled || slugRequestId.current !== requestId) {
        return;
      }
      setSlugAvailability({ status: 'checking', slug });
      void checkSlugAvailability(slug, abortController.signal)
        .then((result) => {
          if (cancelled || slugRequestId.current !== requestId) {
            return;
          }
          if (result.slug !== slug) {
            setSlugAvailability({
              status: 'error',
              slug,
              message: t('onboarding.preflight.slugCheckFailed'),
            });
            return;
          }
          setSlugAvailability({
            status: result.available ? 'available' : 'unavailable',
            slug: result.slug,
          });
        })
        .catch((error: unknown) => {
          if (cancelled || slugRequestId.current !== requestId) {
            return;
          }
          setSlugAvailability({
            status: 'error',
            slug,
            message:
              error instanceof ApiError && error.code === 'VALIDATION_ERROR'
                ? t('onboarding.validation.slugFormat')
                : t('onboarding.preflight.slugCheckFailed'),
          });
        });
    }, preflightDelayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      abortController.abort();
    };
  }, [checkSlugAvailability, preflightDelayMs, t, values.tenantSlug]);

  const setFieldValue =
    (field: FieldName) =>
    (event: ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
      setValues((current) => ({
        ...current,
        [field]: event.target.value,
      }));
      setSubmitState((current) => (current === 'confirmed' ? 'idle' : current));
      if (field === 'tenantSlug') {
        const slug = event.target.value.trim();
        if (!slug || !isTenantSlugFormatValid(slug)) {
          setSlugAvailability({ status: 'idle', slug });
        }
      }
    };

  const markTouched = (field: FieldName) => () => {
    setTouched((current) => ({ ...current, [field]: true }));
  };

  const hasLocalErrors = Object.keys(validationErrors).length > 0;
  const slugIsAvailable =
    activeSlugAvailability.status === 'available' &&
    activeSlugAvailability.slug === trimmedSlug;
  const canSubmit = !hasLocalErrors && slugIsAvailable && !isSubmitting;

  const submitDisabledReason = (() => {
    if (isSubmitting) {
      return t('onboarding.submit.rechecking');
    }
    if (hasLocalErrors) {
      return t('onboarding.submit.disabledInvalid');
    }
    if (activeSlugAvailability.status === 'checking') {
      return t('onboarding.submit.disabledChecking');
    }
    if (activeSlugAvailability.status === 'unavailable') {
      return t('onboarding.submit.disabledConflict');
    }
    if (activeSlugAvailability.status === 'error') {
      return t('onboarding.submit.disabledPreflightError');
    }
    return t('onboarding.submit.disabledAwaitingPreflight');
  })();

  const preflightItems = [
    {
      key: 'slug',
      icon:
        activeSlugAvailability.status === 'available'
          ? 'check_circle'
          : activeSlugAvailability.status === 'unavailable' ||
              activeSlugAvailability.status === 'error'
            ? 'error'
            : 'rule',
      label: t('onboarding.preflight.slug'),
      status:
        activeSlugAvailability.status === 'checking'
          ? t('onboarding.preflight.checking')
          : activeSlugAvailability.status === 'available'
            ? t('onboarding.preflight.available')
            : activeSlugAvailability.status === 'unavailable'
              ? t('onboarding.preflight.unavailable')
              : activeSlugAvailability.status === 'error'
                ? t('onboarding.preflight.failed')
                : t('onboarding.preflight.pending'),
      tone:
        activeSlugAvailability.status === 'available'
          ? ('success' as const)
          : activeSlugAvailability.status === 'unavailable' ||
              activeSlugAvailability.status === 'error'
            ? ('danger' as const)
            : activeSlugAvailability.status === 'checking'
              ? ('warning' as const)
              : ('neutral' as const),
    },
    {
      key: 'admin',
      icon: validationErrors.firstAdminEmail
        ? 'alternate_email'
        : 'check_circle',
      label: t('onboarding.preflight.admin'),
      status: validationErrors.firstAdminEmail
        ? t('onboarding.preflight.pending')
        : t('onboarding.preflight.valid'),
      tone: validationErrors.firstAdminEmail
        ? ('neutral' as const)
        : ('success' as const),
    },
    {
      key: 'plan',
      icon: validationErrors.plan ? 'fact_check' : 'check_circle',
      label: t('onboarding.preflight.plan'),
      status: validationErrors.plan
        ? t('onboarding.preflight.pending')
        : t('onboarding.preflight.valid'),
      tone: validationErrors.plan ? ('neutral' as const) : ('success' as const),
    },
  ];

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitAttempted(true);
    setTouched({
      tenantName: true,
      tenantSlug: true,
      firstAdminEmail: true,
      plan: true,
    });

    const latestErrors = getValidationErrors(values);
    if (Object.keys(latestErrors).length > 0 || !slugIsAvailable) {
      return;
    }

    const submittedSlug = values.tenantSlug.trim();
    const requestId = slugRequestId.current + 1;
    slugRequestId.current = requestId;
    submitAbortControllerRef.current?.abort();
    const abortController = new AbortController();
    submitAbortControllerRef.current = abortController;
    setSubmitState('rechecking');
    setSlugAvailability({ status: 'checking', slug: submittedSlug });

    try {
      const result = await checkSlugAvailability(
        submittedSlug,
        abortController.signal,
      );
      if (!mountedRef.current || slugRequestId.current !== requestId) {
        return;
      }
      if (result.slug !== submittedSlug) {
        setSlugAvailability({
          status: 'error',
          slug: submittedSlug,
          message: t('onboarding.preflight.slugCheckFailed'),
        });
        setSubmitState('idle');
        return;
      }
      setSlugAvailability({
        status: result.available ? 'available' : 'unavailable',
        slug: result.slug,
      });
      setSubmitState(result.available ? 'confirmed' : 'idle');
    } catch {
      if (!mountedRef.current || slugRequestId.current !== requestId) {
        return;
      }
      setSlugAvailability({
        status: 'error',
        slug: submittedSlug,
        message: t('onboarding.preflight.slugCheckFailed'),
      });
      setSubmitState('idle');
    } finally {
      if (submitAbortControllerRef.current === abortController) {
        submitAbortControllerRef.current = null;
      }
    }
  };

  return (
    <>
      <PageHeader
        title={t('onboarding.title')}
        description={t('onboarding.description')}
        actions={
          <Button
            variant="secondary"
            icon="arrow_back"
            onClick={() => navigate('/tenants')}
          >
            {t('onboarding.backToTenants')}
          </Button>
        }
      />

      <form
        className="grid gap-md"
        aria-label={t('onboarding.formLabel')}
        onSubmit={handleSubmit}
      >
        <OnboardingSection
          title={t('onboarding.sections.tenantIdentity.title')}
          description={t('onboarding.sections.tenantIdentity.description')}
        >
          <div className="grid gap-md md:grid-cols-2">
            <Input
              label={t('onboarding.fields.tenantName')}
              autoComplete="organization"
              value={values.tenantName}
              onChange={setFieldValue('tenantName')}
              onBlur={markTouched('tenantName')}
              error={visibleError('tenantName')}
              disabled={isSubmitting}
            />
            <Input
              label={t('onboarding.fields.tenantSlug')}
              autoComplete="off"
              inputMode="url"
              value={values.tenantSlug}
              onChange={setFieldValue('tenantSlug')}
              onBlur={markTouched('tenantSlug')}
              error={visibleError('tenantSlug')}
              disabled={isSubmitting}
            />
          </div>
        </OnboardingSection>

        <OnboardingSection
          title={t('onboarding.sections.firstAdmin.title')}
          description={t('onboarding.sections.firstAdmin.description')}
        >
          <Input
            label={t('onboarding.fields.firstAdminEmail')}
            type="email"
            autoComplete="email"
            value={values.firstAdminEmail}
            onChange={setFieldValue('firstAdminEmail')}
            onBlur={markTouched('firstAdminEmail')}
            error={visibleError('firstAdminEmail')}
            disabled={isSubmitting}
          />
        </OnboardingSection>

        <OnboardingSection
          title={t('onboarding.sections.planOptions.title')}
          description={t('onboarding.sections.planOptions.description')}
        >
          <div className="grid gap-md md:grid-cols-2">
            <Select
              label={t('onboarding.fields.plan')}
              value={values.plan}
              onChange={setFieldValue('plan')}
              onBlur={markTouched('plan')}
              error={visibleError('plan')}
              disabled={isSubmitting}
            >
              <option value="" disabled>
                {t('onboarding.plan.placeholder')}
              </option>
              <option value="starter">{t('onboarding.plan.starter')}</option>
              <option value="growth">{t('onboarding.plan.growth')}</option>
              <option value="enterprise">
                {t('onboarding.plan.enterprise')}
              </option>
            </Select>
            <Input
              label={t('onboarding.fields.notes')}
              autoComplete="off"
              value={values.notes}
              onChange={setFieldValue('notes')}
              disabled={isSubmitting}
            />
          </div>
        </OnboardingSection>

        <OnboardingSection
          title={t('onboarding.sections.preflight.title')}
          description={t('onboarding.sections.preflight.description')}
        >
          <ul
            aria-label={t('onboarding.preflight.label')}
            className="grid gap-sm md:grid-cols-3"
          >
            {preflightItems.map((item) => (
              <li
                className="flex items-center gap-sm rounded border border-outline-variant bg-surface-container-lowest p-sm"
                key={item.key}
              >
                <Icon name={item.icon} className="text-outline" />
                <span className="font-body-sm text-body-sm text-on-surface">
                  {item.label}
                </span>
                <Badge tone={item.tone}>{item.status}</Badge>
              </li>
            ))}
          </ul>
          <p
            aria-live="polite"
            className="font-body-sm text-body-sm text-on-surface-variant"
          >
            {activeSlugAvailability.status === 'checking'
              ? t('onboarding.preflight.slugCheckingLive')
              : activeSlugAvailability.status === 'available'
                ? t('onboarding.preflight.slugAvailableLive')
                : activeSlugAvailability.status === 'unavailable'
                  ? t('onboarding.validation.slugUnavailable')
                  : activeSlugAvailability.status === 'error'
                    ? activeSlugAvailability.message
                    : t('onboarding.preflight.slugPendingLive')}
          </p>
        </OnboardingSection>

        <div className="flex flex-col items-end gap-xs">
          <Button
            type="submit"
            icon={isSubmitting ? 'hourglass_top' : 'send'}
            disabled={!canSubmit}
            aria-describedby="onboarding-submit-disabled-reason"
          >
            {isSubmitting
              ? t('onboarding.submit.recheckingButton')
              : t('onboarding.submit.label')}
          </Button>
          <p
            className="max-w-md text-right font-body-sm text-body-sm text-on-surface-variant"
            id="onboarding-submit-disabled-reason"
            aria-live="polite"
          >
            {submitState === 'confirmed'
              ? t('onboarding.submit.confirmedNoAttempt')
              : submitDisabledReason}
          </p>
        </div>
      </form>
    </>
  );
}

export function TenantOnboardingPage(props: TenantOnboardingPageProps = {}) {
  const { currentUser } = useAuth();
  const navigate = useNavigate();

  if (!canOnboardTenants(currentUser)) {
    return (
      <PermissionDeniedPage
        titleKey="onboarding.denied.title"
        descriptionKey="onboarding.denied.description"
        permissionCode={SYSTEM_TENANTS_ONBOARD_PERMISSION}
        action={{
          labelKey: 'onboarding.denied.backToTenants',
          onClick: () => navigate('/tenants'),
        }}
      />
    );
  }

  return <TenantOnboardingForm {...props} />;
}
