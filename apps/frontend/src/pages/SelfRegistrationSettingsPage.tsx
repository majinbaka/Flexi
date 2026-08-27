import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { TenantSettingsDto } from '@flexi/shared-types';
import { Badge, Button, Card, Icon, Input, PageHeader } from '../components/ui';
import { parseDomainList } from '../lib/list-input';
import { describeUserError } from '../lib/user-error-message';
import { getTenantSettings, updateTenantSettings } from '../lib/users-api';

export interface SelfRegistrationSettingsPageProps {
  /** Injectable for Storybook and focused UI tests; production uses the API. */
  fetchSettings?: typeof getTenantSettings;
  saveSettings?: typeof updateTenantSettings;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; settings: TenantSettingsDto };

type SaveState =
  | { status: 'idle' }
  | { status: 'saving' }
  | { status: 'saved' }
  | { status: 'error'; message: string };

/**
 * The tenant's self-registration policy: the master switch, the email
 * domain whitelist and the approval requirement.
 *
 * The **default role** is shown but not editable. `PATCH
 * /api/tenant-settings` accepts `defaultRoleId`, but no endpoint serves a
 * list of roles to pick from, and offering only "clear it" would let an
 * administrator turn a working policy into one that refuses every
 * registration with no way to put it back. The current value is rendered
 * read-only from `defaultRoleName`, which the GET already returns; the
 * picker follows the roles endpoint.
 */
export function SelfRegistrationSettingsPage({
  fetchSettings = getTenantSettings,
  saveSettings = updateTenantSettings,
}: SelfRegistrationSettingsPageProps = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [load, setLoad] = useState<LoadState>({ status: 'loading' });
  const [reloadKey, setReloadKey] = useState(0);
  const [save, setSave] = useState<SaveState>({ status: 'idle' });

  const [allowSelfRegistration, setAllowSelfRegistration] = useState(false);
  const [requireApproval, setRequireApproval] = useState(true);
  const [domainsDraft, setDomainsDraft] = useState('');

  useEffect(() => {
    const controller = new AbortController();

    fetchSettings({ signal: controller.signal })
      .then((settings) => {
        if (controller.signal.aborted) return;
        setLoad({ status: 'ready', settings });
        setAllowSelfRegistration(settings.allowSelfRegistration);
        setRequireApproval(settings.requireApproval);
        setDomainsDraft(settings.allowedEmailDomains.join(', '));
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoad({ status: 'error' });
      });

    return () => controller.abort();
  }, [fetchSettings, reloadKey]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSave({ status: 'saving' });

    try {
      const settings = await saveSettings({
        allowSelfRegistration,
        requireApproval,
        allowedEmailDomains: parseDomainList(domainsDraft),
      });
      setLoad({ status: 'ready', settings });
      setDomainsDraft(settings.allowedEmailDomains.join(', '));
      setSave({ status: 'saved' });
    } catch (error) {
      setSave({ status: 'error', message: describeUserError(error, t) });
    }
  }

  return (
    <>
      <PageHeader
        title={t('selfRegistration.title')}
        description={t('selfRegistration.description')}
        actions={
          <Button
            variant="secondary"
            icon="arrow_back"
            onClick={() => navigate('/users')}
          >
            {t('selfRegistration.actions.back')}
          </Button>
        }
      />

      {load.status === 'loading' && (
        <Card role="status" className="text-body-sm text-on-surface-variant">
          {t('selfRegistration.loading')}
        </Card>
      )}

      {load.status === 'error' && (
        <Card role="alert" className="flex flex-col items-start gap-md">
          <p className="font-body-base text-body-base text-on-surface">
            {t('selfRegistration.loadError')}
          </p>
          <Button
            variant="secondary"
            icon="refresh"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            {t('users.actions.retry')}
          </Button>
        </Card>
      )}

      {load.status === 'ready' && (
        <Card>
          <form className="flex flex-col gap-lg" onSubmit={handleSubmit}>
            {!load.settings.configured && (
              <p className="flex items-center gap-xs font-body-sm text-body-sm text-on-surface-variant">
                <Badge tone="neutral">
                  {t('selfRegistration.notConfigured')}
                </Badge>
                <span>{t('selfRegistration.notConfiguredHint')}</span>
              </p>
            )}

            <label className="flex items-start gap-sm font-body-sm text-body-sm text-on-surface">
              <input
                type="checkbox"
                checked={allowSelfRegistration}
                onChange={(event) =>
                  setAllowSelfRegistration(event.target.checked)
                }
              />
              <span>
                <span className="font-medium">
                  {t('selfRegistration.allowLabel')}
                </span>
                <span className="block text-on-surface-variant">
                  {t('selfRegistration.allowHint')}
                </span>
              </span>
            </label>

            <label className="flex items-start gap-sm font-body-sm text-body-sm text-on-surface">
              <input
                type="checkbox"
                checked={requireApproval}
                onChange={(event) => setRequireApproval(event.target.checked)}
              />
              <span>
                <span className="font-medium">
                  {t('selfRegistration.requireApprovalLabel')}
                </span>
                <span className="block text-on-surface-variant">
                  {t('selfRegistration.requireApprovalHint')}
                </span>
              </span>
            </label>

            <div className="flex flex-col gap-xs">
              <Input
                label={t('selfRegistration.domainsLabel')}
                placeholder={t('selfRegistration.domainsPlaceholder')}
                value={domainsDraft}
                onChange={(event) => setDomainsDraft(event.target.value)}
              />
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {t('selfRegistration.domainsHint')}
              </p>
            </div>

            <div className="flex flex-col gap-xs">
              <span className="font-label-caps text-label-caps uppercase tracking-wider text-on-surface-variant">
                {t('selfRegistration.defaultRoleLabel')}
              </span>
              <p className="font-body-sm text-body-sm text-on-surface">
                {load.settings.defaultRoleName ??
                  t('selfRegistration.defaultRoleNone')}
              </p>
              <p className="font-body-sm text-body-sm text-on-surface-variant">
                {t('selfRegistration.defaultRoleReadOnly')}
              </p>
            </div>

            {save.status === 'error' && (
              <div
                role="alert"
                className="flex items-start gap-sm rounded bg-error-container p-sm font-body-sm text-body-sm text-on-error-container"
              >
                <Icon name="error" size={18} />
                <p>{save.message}</p>
              </div>
            )}

            {save.status === 'saved' && (
              <p
                role="status"
                className="flex items-center gap-xs font-body-sm text-body-sm text-on-surface-variant"
              >
                <Icon name="check_circle" size={16} />
                {t('selfRegistration.saved')}
              </p>
            )}

            <div className="flex justify-end">
              <Button
                type="submit"
                icon="save"
                disabled={save.status === 'saving'}
              >
                {save.status === 'saving'
                  ? t('selfRegistration.actions.saving')
                  : t('selfRegistration.actions.save')}
              </Button>
            </div>
          </form>
        </Card>
      )}
    </>
  );
}
