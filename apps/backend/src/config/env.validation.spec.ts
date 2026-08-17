import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { envValidationSchema } from './env.validation';

/**
 * Regression coverage for the spec's "Startup fails loudly if DATABASE_URL
 * unset" acceptance criterion. ignoreEnvFile:true so these tests are
 * isolated from whatever apps/backend/.env happens to contain locally.
 */
describe('envValidationSchema', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('fails module compilation when DATABASE_URL is unset', async () => {
    delete process.env.DATABASE_URL;

    await expect(
      Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            validationSchema: envValidationSchema,
          }),
        ],
      }).compile(),
    ).rejects.toThrow(/DATABASE_URL/);
  });

  it('compiles successfully when DATABASE_URL is set', async () => {
    process.env.DATABASE_URL = 'postgresql://user:pass@localhost:5432/flexi';

    await expect(
      Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            validationSchema: envValidationSchema,
          }),
        ],
      }).compile(),
    ).resolves.toBeDefined();
  });
});
