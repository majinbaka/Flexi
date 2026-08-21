import type { ReactNode } from 'react';
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
import { PermissionDeniedPage } from './PermissionDeniedPage';

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
      <fieldset className="flex flex-col gap-md" aria-describedby={descriptionId}>
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

export function TenantOnboardingPage() {
  const { t } = useTranslation();
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
        onSubmit={(event) => event.preventDefault()}
      >
        <OnboardingSection
          title={t('onboarding.sections.tenantIdentity.title')}
          description={t('onboarding.sections.tenantIdentity.description')}
        >
          <div className="grid gap-md md:grid-cols-2">
            <Input
              label={t('onboarding.fields.tenantName')}
              autoComplete="off"
            />
            <Input
              label={t('onboarding.fields.tenantSlug')}
              autoComplete="off"
              inputMode="url"
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
            autoComplete="off"
          />
        </OnboardingSection>

        <OnboardingSection
          title={t('onboarding.sections.planOptions.title')}
          description={t('onboarding.sections.planOptions.description')}
        >
          <div className="grid gap-md md:grid-cols-2">
            <Select label={t('onboarding.fields.plan')} defaultValue="">
              <option value="" disabled>
                {t('onboarding.plan.placeholder')}
              </option>
              <option value="starter">{t('onboarding.plan.starter')}</option>
              <option value="growth">{t('onboarding.plan.growth')}</option>
              <option value="enterprise">
                {t('onboarding.plan.enterprise')}
              </option>
            </Select>
            <Input label={t('onboarding.fields.notes')} autoComplete="off" />
          </div>
        </OnboardingSection>

        <OnboardingSection
          title={t('onboarding.sections.preflight.title')}
          description={t('onboarding.sections.preflight.description')}
        >
          <ul
            aria-label={t('onboarding.preflight.label')}
            aria-live="polite"
            className="grid gap-sm md:grid-cols-3"
          >
            {[
              ['rule', t('onboarding.preflight.slug')],
              ['alternate_email', t('onboarding.preflight.admin')],
              ['fact_check', t('onboarding.preflight.plan')],
            ].map(([icon, label]) => (
              <li
                className="flex items-center gap-sm rounded border border-outline-variant bg-surface-container-lowest p-sm"
                key={label}
              >
                <Icon name={icon} className="text-outline" />
                <span className="font-body-sm text-body-sm text-on-surface">
                  {label}
                </span>
                <Badge tone="warning">{t('onboarding.preflight.pending')}</Badge>
              </li>
            ))}
          </ul>
        </OnboardingSection>

        <div className="flex flex-col items-end gap-xs">
          <Button
            type="submit"
            icon="send"
            disabled
            aria-describedby="onboarding-submit-disabled-reason"
          >
            {t('onboarding.submitDisabled')}
          </Button>
          <p
            className="max-w-md text-right font-body-sm text-body-sm text-on-surface-variant"
            id="onboarding-submit-disabled-reason"
          >
            {t('onboarding.submitDisabledReason')}
          </p>
        </div>
      </form>
    </>
  );
}
