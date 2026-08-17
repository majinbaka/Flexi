import * as Joi from 'joi';

/**
 * Env validation schema consumed by ConfigModule.forRoot({ validationSchema }).
 * Nest fails fast (throws on bootstrap) if a required variable is missing --
 * satisfies the spec's "Startup fails loudly if DATABASE_URL unset" requirement.
 */
export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),
  PORT: Joi.number().default(3000),
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().optional(),
  // Comma-separated list of allowed CORS origins (e.g.
  // "https://app.example.com,https://admin.example.com"). Left unset for
  // local dev, where CORS stays fully permissive -- see main.ts.
  CORS_ORIGIN: Joi.string().optional(),
});
