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
});
