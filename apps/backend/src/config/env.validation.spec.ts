import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { envValidationSchema } from './env.validation';

/**
 * Regression coverage for the spec's "Startup fails loudly if DATABASE_URL
 * unset" acceptance criterion, and (spec-core-authentication.md) the same
 * fail-fast pattern for JWT_ACCESS_SECRET/JWT_REFRESH_SECRET.
 * ignoreEnvFile:true so these tests are isolated from whatever
 * apps/backend/.env happens to contain locally.
 */
describe('envValidationSchema', () => {
  const originalEnv = process.env;

  const validEnv = {
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/flexi',
    JWT_ACCESS_SECRET: 'test-access-secret-at-least-32-characters-long',
    JWT_REFRESH_SECRET: 'test-refresh-secret-at-least-32-characters-long',
  };

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  function compile(): Promise<unknown> {
    return Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validationSchema: envValidationSchema,
        }),
      ],
    }).compile();
  }

  it('fails module compilation when DATABASE_URL is unset', async () => {
    Object.assign(process.env, validEnv);
    delete process.env.DATABASE_URL;

    await expect(compile()).rejects.toThrow(/DATABASE_URL/);
  });

  it('fails module compilation when JWT_ACCESS_SECRET is unset', async () => {
    Object.assign(process.env, validEnv);
    delete process.env.JWT_ACCESS_SECRET;

    await expect(compile()).rejects.toThrow(/JWT_ACCESS_SECRET/);
  });

  it('fails module compilation when JWT_REFRESH_SECRET is unset', async () => {
    Object.assign(process.env, validEnv);
    delete process.env.JWT_REFRESH_SECRET;

    await expect(compile()).rejects.toThrow(/JWT_REFRESH_SECRET/);
  });

  it('compiles successfully when all required vars are set', async () => {
    Object.assign(process.env, validEnv);

    await expect(compile()).resolves.toBeDefined();
  });

  it('fails module compilation when JWT_ACCESS_SECRET is shorter than 32 characters', async () => {
    Object.assign(process.env, validEnv);
    process.env.JWT_ACCESS_SECRET = 'too-short';

    await expect(compile()).rejects.toThrow(/JWT_ACCESS_SECRET/);
  });

  it('fails module compilation when JWT_ACCESS_EXPIRES_IN does not match the accepted duration format', async () => {
    Object.assign(process.env, validEnv);
    process.env.JWT_ACCESS_EXPIRES_IN = '2 days';

    await expect(compile()).rejects.toThrow(/JWT_ACCESS_EXPIRES_IN/);
  });

  it('compiles successfully when TRUST_PROXY_HOPS is a non-negative integer', async () => {
    Object.assign(process.env, validEnv);
    process.env.TRUST_PROXY_HOPS = '1';

    await expect(compile()).resolves.toBeDefined();
  });

  it('compiles successfully when TRUST_PROXY_HOPS is 0', async () => {
    Object.assign(process.env, validEnv);
    process.env.TRUST_PROXY_HOPS = '0';

    await expect(compile()).resolves.toBeDefined();
  });

  it('compiles successfully when TRUST_PROXY_HOPS is unset (disabled by default)', async () => {
    Object.assign(process.env, validEnv);
    delete process.env.TRUST_PROXY_HOPS;

    await expect(compile()).resolves.toBeDefined();
  });

  it('fails module compilation when TRUST_PROXY_HOPS is negative', async () => {
    Object.assign(process.env, validEnv);
    process.env.TRUST_PROXY_HOPS = '-1';

    await expect(compile()).rejects.toThrow(/TRUST_PROXY_HOPS/);
  });

  it('fails module compilation when TRUST_PROXY_HOPS is not an integer', async () => {
    Object.assign(process.env, validEnv);
    process.env.TRUST_PROXY_HOPS = '1.5';

    await expect(compile()).rejects.toThrow(/TRUST_PROXY_HOPS/);
  });

  it('fails module compilation when TRUST_PROXY_HOPS is not numeric', async () => {
    Object.assign(process.env, validEnv);
    process.env.TRUST_PROXY_HOPS = 'abc';

    await expect(compile()).rejects.toThrow(/TRUST_PROXY_HOPS/);
  });

  it('fails module compilation when AUTH_THROTTLE_TTL is zero', async () => {
    Object.assign(process.env, validEnv);
    process.env.AUTH_THROTTLE_TTL = '0';

    await expect(compile()).rejects.toThrow(/AUTH_THROTTLE_TTL/);
  });

  it('fails module compilation when AUTH_THROTTLE_LIMIT is not an integer', async () => {
    Object.assign(process.env, validEnv);
    process.env.AUTH_THROTTLE_LIMIT = '2.5';

    await expect(compile()).rejects.toThrow(/AUTH_THROTTLE_LIMIT/);
  });

  it('compiles successfully when AUTH_THROTTLE_TTL and AUTH_THROTTLE_LIMIT are unset (defaults apply)', async () => {
    Object.assign(process.env, validEnv);
    delete process.env.AUTH_THROTTLE_TTL;
    delete process.env.AUTH_THROTTLE_LIMIT;

    await expect(compile()).resolves.toBeDefined();
  });

  // DynamicTables DDL worker tunables (apps/backend/src/modules/
  // dynamic-tables/ddl-worker.ts) -- same .integer().positive().default(...)
  // convention as AUTH_THROTTLE_TTL above.
  it('compiles successfully when DDL_LOCK_TIMEOUT_MS/DDL_STATEMENT_TIMEOUT_MS/DDL_JOB_RETRY_COUNT are unset (defaults apply)', async () => {
    Object.assign(process.env, validEnv);
    delete process.env.DDL_LOCK_TIMEOUT_MS;
    delete process.env.DDL_STATEMENT_TIMEOUT_MS;
    delete process.env.DDL_JOB_RETRY_COUNT;

    await expect(compile()).resolves.toBeDefined();
  });

  it('fails module compilation when DDL_LOCK_TIMEOUT_MS is zero', async () => {
    Object.assign(process.env, validEnv);
    process.env.DDL_LOCK_TIMEOUT_MS = '0';

    await expect(compile()).rejects.toThrow(/DDL_LOCK_TIMEOUT_MS/);
  });

  it('fails module compilation when DDL_STATEMENT_TIMEOUT_MS is negative', async () => {
    Object.assign(process.env, validEnv);
    process.env.DDL_STATEMENT_TIMEOUT_MS = '-1';

    await expect(compile()).rejects.toThrow(/DDL_STATEMENT_TIMEOUT_MS/);
  });

  it('fails module compilation when DDL_JOB_RETRY_COUNT is not an integer', async () => {
    Object.assign(process.env, validEnv);
    process.env.DDL_JOB_RETRY_COUNT = '2.5';

    await expect(compile()).rejects.toThrow(/DDL_JOB_RETRY_COUNT/);
  });

  it('applies finite Dynamic Tables guardrail defaults when they are unset', async () => {
    Object.assign(process.env, validEnv);
    delete process.env.DYNAMIC_TABLES_MAX_TABLES_PER_TENANT;
    delete process.env.DYNAMIC_TABLES_MAX_FIELDS_PER_TABLE;
    delete process.env.DYNAMIC_TABLES_MAX_MUTATION_PAYLOAD_BYTES;
    delete process.env.DYNAMIC_TABLES_MAX_PAGE_SIZE;

    await expect(compile()).resolves.toBeDefined();
  });

  it.each([
    'DYNAMIC_TABLES_MAX_TABLES_PER_TENANT',
    'DYNAMIC_TABLES_MAX_FIELDS_PER_TABLE',
    'DYNAMIC_TABLES_MAX_MUTATION_PAYLOAD_BYTES',
    'DYNAMIC_TABLES_MAX_PAGE_SIZE',
  ])('rejects a non-positive Dynamic Tables guardrail: %s', async (key) => {
    Object.assign(process.env, validEnv, { [key]: '0' });

    await expect(compile()).rejects.toThrow(new RegExp(key));
  });

  it('compiles with SMTP explicitly disabled in development', async () => {
    Object.assign(process.env, validEnv, {
      NODE_ENV: 'development',
      SMTP_ENABLED: 'false',
    });
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USERNAME;
    delete process.env.SMTP_PASSWORD;
    delete process.env.SMTP_FROM;

    await expect(compile()).resolves.toBeDefined();
  });

  it('requires complete SMTP configuration when explicitly enabled', async () => {
    Object.assign(process.env, validEnv, {
      SMTP_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '587',
      SMTP_USERNAME: 'smtp-user',
      SMTP_FROM: 'noreply@example.com',
    });
    delete process.env.SMTP_PASSWORD;

    await expect(compile()).rejects.toThrow(/SMTP_PASSWORD/);
  });

  it('validates SMTP port, sender, TLS, and timeout values', async () => {
    Object.assign(process.env, validEnv, {
      SMTP_ENABLED: 'true',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '70000',
      SMTP_USERNAME: 'smtp-user',
      SMTP_PASSWORD: 'smtp-password',
      SMTP_FROM: 'not-an-email',
      SMTP_SECURE: 'not-a-boolean',
      SMTP_TIMEOUT_MS: '0',
    });

    await expect(compile()).rejects.toThrow(/SMTP_PORT/);
  });

  it('rejects a setup-account URL base that is not an HTTP(S) URL', async () => {
    Object.assign(process.env, validEnv, {
      SETUP_ACCOUNT_URL_BASE: 'not a URL',
    });

    await expect(compile()).rejects.toThrow(/SETUP_ACCOUNT_URL_BASE/);
  });

  it('requires SMTP configuration by default in production', async () => {
    Object.assign(process.env, validEnv, { NODE_ENV: 'production' });
    delete process.env.SMTP_ENABLED;
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USERNAME;
    delete process.env.SMTP_PASSWORD;
    delete process.env.SMTP_FROM;

    await expect(compile()).rejects.toThrow(/SMTP_HOST/);
  });

  it('allows a production deployment to explicitly disable SMTP', async () => {
    Object.assign(process.env, validEnv, {
      NODE_ENV: 'production',
      SMTP_ENABLED: 'false',
    });
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USERNAME;
    delete process.env.SMTP_PASSWORD;
    delete process.env.SMTP_FROM;

    await expect(compile()).resolves.toBeDefined();
  });
});
