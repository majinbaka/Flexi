import { INestApplication } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Test, TestingModule } from '@nestjs/testing';
import { MVP_PERMISSION_CATALOG, PermissionScope } from '@flexi/shared-types';
import type { Queue } from 'bullmq';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import type { AppModule as AppModuleType } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resolveTenantSchema } from '../src/tenancy/resolve-tenant-schema';
import {
  DDL_QUEUE_NAME,
  DdlJobData,
} from '../src/modules/dynamic-tables/dynamic-tables.types';

process.env.AUTH_THROTTLE_LIMIT = '50';
process.env.AUTH_THROTTLE_TTL = '60';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AppModule } = require('../src/app.module') as {
  AppModule: typeof AppModuleType;
};

/**
 * Exercises the MVP's dynamic-table surface against a live Postgres-backed
 * BullMQ worker. Permission records are deliberately read from the migrated
 * production catalog rather than invented by this test, while actors, roles,
 * tenant schemas, and queue jobs are all cleaned up afterwards.
 */
describe('DynamicTables (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ddlQueue: Queue<DdlJobData>;
  let tenantId: string;
  let authAccountId: string;
  let accessToken: string;
  let contactsTableId: string;
  let readerTenantId: string;
  let readerAuthAccountId: string;
  let readerAccessToken: string;
  const runId = Date.now().toString();
  const email = `e2e-dynamic-tables-${runId}@example.com`;
  const readerEmail = `e2e-dynamic-tables-reader-${runId}@example.com`;
  const password = 'E2ePassword123!';
  const acceptedJobIds: string[] = [];
  const dynamicTablePermissions = MVP_PERMISSION_CATALOG.filter(
    (permission) =>
      permission.scope === PermissionScope.TENANT &&
      permission.code.startsWith('dynamic-tables.'),
  );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    prisma = app.get(PrismaService);
    ddlQueue = app.get<Queue<DdlJobData>>(getQueueToken(DDL_QUEUE_NAME));

    const permissions = await prisma.permission.findMany({
      where: { code: { in: dynamicTablePermissions.map(({ code }) => code) } },
    });
    expect(permissions).toHaveLength(dynamicTablePermissions.length);
    expect(permissions).toEqual(
      expect.arrayContaining(
        dynamicTablePermissions.map(({ code, scope }) =>
          expect.objectContaining({ code, scope }),
        ),
      ),
    );

    const tenant = await prisma.tenant.create({
      data: {
        name: 'E2E DynamicTables Tenant',
        slug: `e2e-dynamic-tables-${runId}`,
      },
    });
    tenantId = tenant.id;
    await createTenantSchema(tenantId);

    const role = await prisma.role.create({
      data: {
        tenantId,
        name: 'E2E DynamicTables Role',
        rolePermissions: {
          create: permissions.map((permission) => ({
            permissionId: permission.id,
          })),
        },
      },
    });

    const authAccount = await prisma.authAccount.create({
      data: { email, passwordHash: await bcrypt.hash(password, 4) },
    });
    authAccountId = authAccount.id;
    await prisma.tenantUser.create({
      data: {
        tenantId,
        authAccountId: authAccount.id,
        name: 'E2E DynamicTables User',
        roles: { connect: [{ id: role.id }] },
      },
    });
    accessToken = await login(tenantId, email);

    // This target exists before the lifecycle test adds its RELATION field.
    contactsTableId = await createTableAndWait(`e2e_contacts_${runId}`, [
      { name: 'name', dataType: 'STRING', required: true },
    ]);

    const readerTenant = await prisma.tenant.create({
      data: {
        name: 'E2E DynamicTables Reader Tenant',
        slug: `e2e-dynamic-tables-reader-${runId}`,
      },
    });
    readerTenantId = readerTenant.id;
    const readerSchema = resolveTenantSchema(readerTenantId);
    await prisma.$executeRawUnsafe(
      `CREATE SCHEMA IF NOT EXISTS "${readerSchema}"`,
    );
    await prisma.$executeRawUnsafe(`
      CREATE TABLE "${readerSchema}"."_meta_tables" (
        id text PRIMARY KEY,
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        description text NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await prisma.$executeRawUnsafe(
      `INSERT INTO "${readerSchema}"."_meta_tables" (id, name, slug)
       VALUES ('reader-table', 'Reader table', 'reader_table')`,
    );

    const readerRole = await prisma.role.create({
      data: {
        tenantId: readerTenantId,
        name: 'E2E DynamicTables Reader Role',
        rolePermissions: {
          create: permissions.map((permission) => ({
            permissionId: permission.id,
          })),
        },
      },
    });
    const readerAccount = await prisma.authAccount.create({
      data: {
        email: readerEmail,
        passwordHash: await bcrypt.hash(password, 4),
      },
    });
    readerAuthAccountId = readerAccount.id;
    await prisma.tenantUser.create({
      data: {
        tenantId: readerTenantId,
        authAccountId: readerAccount.id,
        name: 'E2E Metadata Reader',
        roles: { connect: [{ id: readerRole.id }] },
      },
    });
    readerAccessToken = await login(readerTenantId, readerEmail);
  });

  afterAll(async () => {
    if (!app || !prisma) {
      return;
    }
    await Promise.all(
      acceptedJobIds.map(async (jobId) => {
        const job = await ddlQueue.getJob(jobId);
        await job?.remove();
      }),
    );
    await Promise.all([
      dropTenantSchema(tenantId),
      dropTenantSchema(readerTenantId),
    ]);
    if (tenantId) {
      await prisma.tenant.delete({ where: { id: tenantId } });
    }
    if (readerTenantId) {
      await prisma.tenant.delete({ where: { id: readerTenantId } });
    }
    if (authAccountId) {
      await prisma.authAccount.delete({ where: { id: authAccountId } });
    }
    if (readerAuthAccountId) {
      await prisma.authAccount.delete({ where: { id: readerAuthAccountId } });
    }
    await app.close();
  });

  it('executes the create-to-delete MVP lifecycle, including field edits, relation resolution, and pagination', async () => {
    const invoicesTableId = await createTableAndWait(`e2e_invoices_${runId}`, [
      { name: 'title', dataType: 'STRING', required: true },
      { name: 'amount', dataType: 'NUMBER', required: false },
    ]);

    const catalogResponse = await authorized()
      .get('/api/tables?page=1&pageSize=10')
      .expect(200);
    expect(catalogResponse.body.data).toMatchObject({
      meta: { page: 1, pageSize: 10, total: 2 },
      items: expect.arrayContaining([
        expect.objectContaining({ id: invoicesTableId }),
      ]),
    });

    const initialDetail = await authorized()
      .get(`/api/tables/${invoicesTableId}`)
      .expect(200);
    expect(initialDetail.body.data.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slug: 'title',
          dataType: 'STRING',
          required: true,
        }),
        expect.objectContaining({
          slug: 'amount',
          dataType: 'NUMBER',
          required: false,
        }),
      ]),
    );

    await editFieldsAndWait(invoicesTableId, [
      { operation: 'add', name: 'notes', dataType: 'TEXT', required: false },
    ]);
    await editFieldsAndWait(invoicesTableId, [
      {
        operation: 'add',
        name: 'contact',
        dataType: 'RELATION',
        relatedTableId: contactsTableId,
      },
    ]);

    const editedDetail = await authorized()
      .get(`/api/tables/${invoicesTableId}`)
      .expect(200);
    expect(editedDetail.body.data.fields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ slug: 'notes', dataType: 'TEXT' }),
        expect.objectContaining({
          slug: 'contact',
          dataType: 'RELATION',
          relationTargetTableId: contactsTableId,
        }),
      ]),
    );

    const contact = await authorized()
      .post(`/api/tables/${contactsTableId}/rows`)
      .send({ name: 'Ada Lovelace' })
      .expect(201);
    const contactId = contact.body.data.id as number;

    const firstInvoice = await authorized()
      .post(`/api/tables/${invoicesTableId}/rows`)
      .send({ title: 'Alpha', amount: 10, notes: 'First', contact: contactId })
      .expect(201);
    const firstInvoiceId = firstInvoice.body.data.id as number;
    await authorized()
      .post(`/api/tables/${invoicesTableId}/rows`)
      .send({ title: 'Bravo', amount: 20, notes: 'Second', contact: contactId })
      .expect(201);
    await authorized()
      .post(`/api/tables/${invoicesTableId}/rows`)
      .send({
        title: 'Charlie',
        amount: 30,
        notes: 'Third',
        contact: contactId,
      })
      .expect(201);

    const page = await authorized()
      .get(
        `/api/tables/${invoicesTableId}/rows?page=1&pageSize=2&sortBy=title&sortDirection=asc`,
      )
      .expect(200);
    expect(page.body.data).toMatchObject({
      meta: { total: 3, page: 1, pageSize: 2 },
      items: [
        expect.objectContaining({
          id: firstInvoiceId,
          title: 'Alpha',
          contact: expect.objectContaining({
            id: contactId,
            name: 'Ada Lovelace',
          }),
        }),
        expect.objectContaining({ title: 'Bravo' }),
      ],
    });

    const updated = await authorized()
      .patch(`/api/tables/${invoicesTableId}/rows/${firstInvoiceId}`)
      .send({ amount: 99, notes: 'Updated' })
      .expect(200);
    expect(updated.body.data).toMatchObject({
      id: firstInvoiceId,
      amount: '99.00',
      notes: 'Updated',
    });

    const fetched = await authorized()
      .get(`/api/tables/${invoicesTableId}/rows/${firstInvoiceId}`)
      .expect(200);
    expect(fetched.body.data).toMatchObject({
      id: firstInvoiceId,
      contact: expect.objectContaining({ id: contactId, name: 'Ada Lovelace' }),
    });

    await authorized()
      .delete(`/api/tables/${invoicesTableId}/rows/${firstInvoiceId}`)
      .expect(204);
    await authorized()
      .get(`/api/tables/${invoicesTableId}/rows/${firstInvoiceId}`)
      .expect(404);
  });

  it('isolates metadata and rows across tenants', async () => {
    const readerCatalogResponse = await request(app.getHttpServer())
      .get('/api/tables')
      .set('Authorization', `Bearer ${readerAccessToken}`)
      .expect(200);
    expect(readerCatalogResponse.body.data.items).toEqual([
      expect.objectContaining({ id: 'reader-table', slug: 'reader_table' }),
    ]);

    const foreignDetail = await request(app.getHttpServer())
      .get(`/api/tables/${contactsTableId}`)
      .set('Authorization', `Bearer ${readerAccessToken}`)
      .expect(404);
    expect(foreignDetail.body.success).toBe(false);

    const foreignRows = await request(app.getHttpServer())
      .get(`/api/tables/${contactsTableId}/rows`)
      .set('Authorization', `Bearer ${readerAccessToken}`)
      .expect(404);
    expect(foreignRows.body.success).toBe(false);
  });

  it('enforces bounded pagination and mutation-payload guardrails', async () => {
    const tooLargePage = await authorized()
      .get(`/api/tables/${contactsTableId}/rows?pageSize=101`)
      .expect(400);
    expect(tooLargePage.body.error.code).toBe(
      'DYNAMIC_TABLES_PAGE_SIZE_EXCEEDED',
    );

    const tooLargePayload = await authorized()
      .post(`/api/tables/${contactsTableId}/rows`)
      .send({ name: 'x'.repeat(66000) })
      .expect(400);
    expect(tooLargePayload.body.error.code).toBe(
      'DYNAMIC_TABLES_MUTATION_PAYLOAD_TOO_LARGE',
    );
  });

  it('rejects reserved metadata names before creating a DDL job', async () => {
    const response = await authorized()
      .post('/api/tables')
      .send({
        name: '_meta_forbidden',
        fields: [{ name: 'title', dataType: 'STRING' }],
      })
      .expect(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('returns 404 for an unknown DDL job id', async () => {
    const response = await authorized()
      .get('/api/tables/jobs/does-not-exist')
      .expect(404);
    expect(response.body.success).toBe(false);
  });

  function authorized() {
    return request
      .agent(app.getHttpServer())
      .set('Authorization', `Bearer ${accessToken}`);
  }

  async function login(tenant: string, accountEmail: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('x-tenant-id', tenant)
      .send({ email: accountEmail, password })
      .expect(200);
    return response.body.data.accessToken as string;
  }

  async function createTenantSchema(id: string): Promise<void> {
    const schema = resolveTenantSchema(id);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  }

  async function dropTenantSchema(id: string): Promise<void> {
    if (!id) {
      return;
    }
    const schema = resolveTenantSchema(id);
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  }

  async function createTableAndWait(
    name: string,
    fields: Array<{ name: string; dataType: string; required: boolean }>,
  ): Promise<string> {
    const response = await authorized()
      .post('/api/tables')
      .send({ name, fields })
      .expect(202);
    await pollJobUntilDone(response.body.data.jobId as string);

    const schema = resolveTenantSchema(tenantId);
    const rows = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id FROM "${schema}"."_meta_tables" WHERE slug = $1`,
      name,
    );
    expect(rows).toHaveLength(1);
    return rows[0].id;
  }

  async function editFieldsAndWait(
    tableId: string,
    edits: Array<Record<string, unknown>>,
  ): Promise<void> {
    const response = await authorized()
      .patch(`/api/tables/${tableId}/fields`)
      .send({ edits })
      .expect(202);
    await pollJobUntilDone(response.body.data.jobId as string);
  }

  async function pollJobUntilDone(jobId: string): Promise<void> {
    acceptedJobIds.push(jobId);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const response = await authorized()
        .get(`/api/tables/jobs/${jobId}`)
        .expect(200);
      const { status, error } = response.body.data as {
        status: string;
        error: string | null;
      };
      if (status === 'completed') {
        expect(error).toBeNull();
        return;
      }
      if (status === 'failed') {
        throw new Error(`DDL job ${jobId} failed: ${error ?? 'unknown error'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`DDL job ${jobId} did not complete within 30 polls`);
  }
});
