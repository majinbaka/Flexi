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
  // JWT secrets used to sign access/refresh tokens (apps/backend/src/modules/auth).
  // Required, no default -- fail fast on missing secrets, matching
  // DATABASE_URL's existing pattern. Expiries are optional with sane
  // defaults: short-lived access token, longer-lived rotating refresh token.
  // .min(32) so a trivially weak secret can't pass validation.
  JWT_ACCESS_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  // Pattern matches AuthService.durationToSeconds exactly, so an
  // unparseable expiry fails fast at boot instead of on first login/refresh.
  JWT_ACCESS_EXPIRES_IN: Joi.string()
    .pattern(/^\d+\s*(s|m|h|d)?$/i)
    .default('15m'),
  JWT_REFRESH_EXPIRES_IN: Joi.string()
    .pattern(/^\d+\s*(s|m|h|d)?$/i)
    .default('7d'),
  // Comma-separated list of allowed CORS origins (e.g.
  // "https://app.example.com,https://admin.example.com"). Left unset for
  // local dev, where CORS stays fully permissive -- see main.ts.
  CORS_ORIGIN: Joi.string().optional(),
  // Rate limiting for POST /api/auth/login and /api/auth/refresh only (see
  // apps/backend/src/modules/auth/auth.module.ts). TTL is in seconds.
  // .integer().positive() so 0/negative fails startup instead of silently
  // disabling (0) or breaking (negative) the limiter. Sane defaults so no
  // .env change is required for existing setups to keep working.
  AUTH_THROTTLE_TTL: Joi.number().integer().positive().default(60),
  AUTH_THROTTLE_LIMIT: Joi.number().integer().positive().default(5),
});
