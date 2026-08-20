import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import * as bcrypt from 'bcryptjs';
import type { AppModule as AppModuleType } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { resolveTenantSchema } from '../src/tenancy/resolve-tenant-schema';

process.env.AUTH_THROTTLE_LIMIT = '50';
process.env.AUTH_THROTTLE_TTL = '60';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { AppModule } = require('../src/app.module') as {
  AppModule: typeof AppModuleType;
};

/**
 * Real end-to-end coverage of this story's CAP-1 create-table flow through
 * the actual BullMQ (Postgres-backed) DDL queue and worker, against a live
 * Postgres instance -- the part unit tests (which mock TenantKnexService)
 * cannot verify: that the whole `POST /api/tables` -> enqueue -> ddl-worker
 * -> `_meta_tables`/physical table -> `GET /api/tables/jobs/:jobId` chain
 * actually works end to end, including this module's real DI wiring
 * (JwtAuthGuard/PermissionsGuard cross-module resolution, the Postgres
 * BullMQ backend's own migration bootstrap).
 *
 * Tenant schema provisioning is out of this module's scope (spec
 * Non-goals) -- this test creates the tenant's Postgres schema directly via
 * raw SQL in `beforeAll`, standing in for whatever provisioning step will
 * exist later.
 */
describe('DynamicTables (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenantId: string;
  let authAccountId: string;
  let accessToken: string;
  const email = `e2e-dynamic-tables-${Date.now()}@example.com`;
  const password = 'E2ePassword123!';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();

    prisma = app.get(PrismaService);

    const tenant = await prisma.tenant.create({
      data: {
        name: 'E2E DynamicTables Tenant',
        slug: `e2e-dynamic-tables-${Date.now()}`,
      },
    });
    tenantId = tenant.id;

    // Tenant schema provisioning is explicitly out of this module's scope
    // (spec Non-goals) -- create it directly here, standing in for that
    // future step.
    const schema = resolveTenantSchema(tenantId);
    await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);

    const createPermission = await prisma.permission.upsert({
      where: { code: 'dynamic-tables.tables.create' },
      update: { scope: 'TENANT' },
      create: {
        code: 'dynamic-tables.tables.create',
        description: 'E2E: create dynamic tables',
        scope: 'TENANT',
      },
    });
    const jobsReadPermission = await prisma.permission.upsert({
      where: { code: 'dynamic-tables.jobs.read' },
      update: { scope: 'TENANT' },
      create: {
        code: 'dynamic-tables.jobs.read',
        description: 'E2E: read dynamic-table job status',
        scope: 'TENANT',
      },
    });
    const fieldsUpdatePermission = await prisma.permission.upsert({
      where: { code: 'dynamic-tables.fields.update' },
      update: { scope: 'TENANT' },
      create: {
        code: 'dynamic-tables.fields.update',
        description: 'E2E: update dynamic-table fields',
        scope: 'TENANT',
      },
    });

    const role = await prisma.role.create({
      data: {
        tenantId,
        name: 'E2E DynamicTables Role',
        rolePermissions: {
          create: [
            { permissionId: createPermission.id },
            { permissionId: jobsReadPermission.id },
            { permissionId: fieldsUpdatePermission.id },
          ],
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

    const loginResponse = await request(app.getHttpServer())
      .post('/api/auth/login')
      .set('x-tenant-id', tenantId)
      .send({ email, password })
      .expect(200);
    accessToken = loginResponse.body.data.accessToken;
  });

  afterAll(async () => {
    const schema = resolveTenantSchema(tenantId);
    await prisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await prisma.tenant.delete({ where: { id: tenantId } });
    await prisma.authAccount.delete({ where: { id: authAccountId } });
    await app.close();
  });

  async function pollJobUntilDone(
    jobId: string,
    maxAttempts = 30,
  ): Promise<{ status: string; error: string | null }> {
    for (let i = 0; i < maxAttempts; i += 1) {
      const response = await request(app.getHttpServer())
        .get(`/api/tables/jobs/${jobId}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const { status, error } = response.body.data as {
        status: string;
        error: string | null;
      };
      if (status === 'completed' || status === 'failed') {
        return { status, error };
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(
      `Job ${jobId} did not complete within ${maxAttempts} polls`,
    );
  }

  it('creates a table with typed fields via the DDL queue, and the physical table + metadata rows exist on completion', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/api/tables')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'e2e_invoices',
        fields: [
          { name: 'title', dataType: 'STRING', required: true },
          { name: 'amount', dataType: 'NUMBER', required: false },
        ],
      })
      .expect(202);

    const { jobId } = createResponse.body.data as { jobId: string };
    expect(jobId).toEqual(expect.any(String));

    const result = await pollJobUntilDone(jobId);
    expect(result).toEqual({ status: 'completed', error: null });

    const schema = resolveTenantSchema(tenantId);

    const tableExists = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2) as exists`,
      schema,
      'e2e_invoices',
    );
    expect(tableExists[0].exists).toBe(true);

    const metaTableRows = await prisma.$queryRawUnsafe<{ name: string }[]>(
      `SELECT name FROM "${schema}"."_meta_tables" WHERE slug = $1`,
      'e2e_invoices',
    );
    expect(metaTableRows).toHaveLength(1);

    const metaFieldRows = await prisma.$queryRawUnsafe<{ slug: string }[]>(
      `SELECT slug FROM "${schema}"."_meta_fields" WHERE table_id = (SELECT id FROM "${schema}"."_meta_tables" WHERE slug = $1)`,
      'e2e_invoices',
    );
    expect(metaFieldRows.map((r) => r.slug).sort()).toEqual([
      'amount',
      'title',
    ]);
  });

  it('rejects a table name starting with _meta_ with 400, before any job is enqueued', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/tables')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: '_meta_forbidden',
        fields: [{ name: 'title', dataType: 'STRING' }],
      })
      .expect(400);

    expect(response.body.success).toBe(false);
  });

  it('adds an additive field via PATCH .../fields with a single ADD COLUMN, verifiable in the physical table', async () => {
    const createResponse = await request(app.getHttpServer())
      .post('/api/tables')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        name: 'e2e_notes',
        fields: [{ name: 'title', dataType: 'STRING', required: true }],
      })
      .expect(202);

    const createResult = await pollJobUntilDone(
      (createResponse.body.data as { jobId: string }).jobId,
    );
    expect(createResult.status).toBe('completed');

    const schema = resolveTenantSchema(tenantId);
    const metaTableRow = await prisma.$queryRawUnsafe<{ id: string }[]>(
      `SELECT id FROM "${schema}"."_meta_tables" WHERE slug = $1`,
      'e2e_notes',
    );
    const tableId = metaTableRow[0].id;

    const editResponse = await request(app.getHttpServer())
      .patch(`/api/tables/${tableId}/fields`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        edits: [
          { operation: 'add', name: 'body', dataType: 'TEXT', required: false },
        ],
      })
      .expect(202);

    const editResult = await pollJobUntilDone(
      (editResponse.body.data as { jobId: string }).jobId,
    );
    expect(editResult).toEqual({ status: 'completed', error: null });

    const columnExists = await prisma.$queryRawUnsafe<{ exists: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 AND column_name = $3) as exists`,
      schema,
      'e2e_notes',
      'body',
    );
    expect(columnExists[0].exists).toBe(true);
  });

  it('GET /api/tables/jobs/:jobId returns 404 for an unknown job id', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/tables/jobs/does-not-exist')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(404);

    expect(response.body.success).toBe(false);
  });
});
