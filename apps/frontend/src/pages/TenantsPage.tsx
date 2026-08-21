import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { canOnboardTenants } from '../auth/permissions';
import {
  Badge,
  Button,
  PageHeader,
  Table,
  type TableColumn,
} from '../components/ui';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  status: string;
}

const tenantColumns = (
  t: (key: string) => string,
): TableColumn<TenantRow>[] => [
  {
    id: 'name',
    header: t('tenants.table.name'),
    cell: (row) => row.name,
  },
  {
    id: 'slug',
    header: t('tenants.table.slug'),
    cell: (row) => (
      <span className="font-code-sm text-code-sm">{row.slug}</span>
    ),
  },
  {
    id: 'status',
    header: t('tenants.table.status'),
    cell: (row) => <Badge tone="neutral">{row.status}</Badge>,
  },
];

export function TenantsPage() {
  const { t } = useTranslation();
  const { currentUser } = useAuth();
  const navigate = useNavigate();
  const canCreateTenant = canOnboardTenants(currentUser);

  return (
    <>
      <PageHeader
        title={t('tenants.title')}
        description={t('tenants.description')}
        actions={
          canCreateTenant ? (
            <Button
              variant="primary"
              icon="add"
              onClick={() => navigate('/tenants/onboard')}
            >
              {t('tenants.actions.onboard')}
            </Button>
          ) : undefined
        }
      />

      <Table
        columns={tenantColumns(t)}
        rows={[]}
        rowKey={(row) => row.id}
        emptyMessage={t('tenants.empty')}
      />
    </>
  );
}
