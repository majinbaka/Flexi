import * as Joi from 'joi';

function configurationError(helpers: Joi.CustomHelpers, message: string) {
  return helpers.error('any.custom', { message });
}

function normalizeOriginList(value: string, helpers: Joi.CustomHelpers) {
  const normalizedOrigins: string[] = [];

  for (const origin of value.split(',').map((item) => item.trim())) {
    if (!origin) {
      return configurationError(
        helpers,
        'CORS_ORIGIN must not contain an empty origin',
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return configurationError(
        helpers,
        `CORS_ORIGIN contains an invalid origin: ${origin}`,
      );
    }

    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      !['', '/'].includes(parsed.pathname) ||
      parsed.search ||
      parsed.hash
    ) {
      return configurationError(
        helpers,
        `CORS_ORIGIN must contain HTTP(S) origins only: ${origin}`,
      );
    }

    const normalizedOrigin = parsed.origin;
    if (normalizedOrigins.includes(normalizedOrigin)) {
      return configurationError(
        helpers,
        `CORS_ORIGIN contains the same origin more than once: ${normalizedOrigin}`,
      );
    }
    normalizedOrigins.push(normalizedOrigin);
  }

  return normalizedOrigins.join(',');
}

function normalizeSetupAccountUrlBase(
  value: string,
  helpers: Joi.CustomHelpers,
) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return configurationError(
      helpers,
      'SETUP_ACCOUNT_URL_BASE must be an HTTP(S) origin',
    );
  }

  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    !['', '/'].includes(parsed.pathname) ||
    parsed.search ||
    parsed.hash
  ) {
    return configurationError(
      helpers,
      'SETUP_ACCOUNT_URL_BASE must be an HTTP(S) origin without a path, query, hash, or credentials',
    );
  }

  return parsed.origin;
}

function requireHttps(value: string, helpers: Joi.CustomHelpers) {
  if (!value.startsWith('https://')) {
    return configurationError(
      helpers,
      'SETUP_ACCOUNT_URL_BASE must use HTTPS in production',
    );
  }
  return value;
}

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
  JWT_ACCESS_SECRET: Joi.string()
    .min(32)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().min(64),
      otherwise: Joi.string().min(32),
    })
    .required(),
  JWT_REFRESH_SECRET: Joi.string()
    .min(32)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().min(64),
      otherwise: Joi.string().min(32),
    })
    .required(),
  // Pattern matches AuthService.durationToSeconds exactly, so an
  // unparseable expiry fails fast at boot instead of on first login/refresh.
  JWT_ACCESS_EXPIRES_IN: Joi.string()
    .pattern(/^\d+\s*(s|m|h|d)?$/i)
    .default('15m'),
  JWT_REFRESH_EXPIRES_IN: Joi.string()
    .pattern(/^\d+\s*(s|m|h|d)?$/i)
    .default('7d'),
  // Comma-separated list of allowed CORS origins. Origins are canonicalized
  // before main.ts consumes them so casing and trailing slashes cannot create
  // duplicate policy entries. Production must never fall back to wildcard CORS.
  CORS_ORIGIN: Joi.string()
    .trim()
    .custom(normalizeOriginList)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.required(),
      otherwise: Joi.optional(),
    })
    .messages({ 'any.custom': '{{#message}}' }),
  // Rate limiting for POST /api/auth/login and /api/auth/refresh only (see
  // apps/backend/src/modules/auth/auth.module.ts). TTL is in seconds.
  // .integer().positive() so 0/negative fails startup instead of silently
  // disabling (0) or breaking (negative) the limiter. Sane defaults so no
  // .env change is required for existing setups to keep working.
  AUTH_THROTTLE_TTL: Joi.number().integer().positive().default(60),
  AUTH_THROTTLE_LIMIT: Joi.number().integer().positive().default(5),
  // Number of hops to trust for X-Forwarded-For when this app sits behind a
  // reverse proxy/load balancer (see main.ts) -- without it, ThrottlerGuard's
  // IP tracker reads the proxy's own IP for every request, collapsing the
  // per-client rate limit into one shared bucket. Left unset (disabled) by
  // default since no deployment topology in this repo has a proxy in front
  // yet; trusting hops with no real proxy would let a client spoof its own
  // X-Forwarded-For to bypass rate limiting entirely.
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).optional(),
  // DynamicTables DDL worker tunables (apps/backend/src/modules/
  // dynamic-tables/ddl-worker.ts) -- .integer().positive().default(...)
  // mirrors AUTH_THROTTLE_TTL's pattern above so these never get
  // hardcoded. lock_timeout/statement_timeout are set per-transaction
  // (SET LOCAL, never session-level -- see TenantKnexService) for every
  // DDL statement the worker executes; DDL_JOB_RETRY_COUNT bounds BullMQ's
  // built-in retry/backoff attempt count for a queued DDL job.
  DDL_LOCK_TIMEOUT_MS: Joi.number().integer().positive().default(5000),
  DDL_STATEMENT_TIMEOUT_MS: Joi.number().integer().positive().default(30000),
  DDL_JOB_RETRY_COUNT: Joi.number().integer().positive().default(3),
  // Dynamic Tables guardrails. These bound user-controlled runtime-schema
  // growth and request work without introducing a plan/entitlement model.
  // They are deliberately deployment-configurable, with finite defaults.
  DYNAMIC_TABLES_MAX_TABLES_PER_TENANT: Joi.number()
    .integer()
    .positive()
    .default(50),
  DYNAMIC_TABLES_MAX_FIELDS_PER_TABLE: Joi.number()
    .integer()
    .positive()
    .default(100),
  DYNAMIC_TABLES_MAX_MUTATION_PAYLOAD_BYTES: Joi.number()
    .integer()
    .positive()
    .default(65536),
  DYNAMIC_TABLES_MAX_PAGE_SIZE: Joi.number().integer().positive().default(100),
  TENANT_PROVISIONING_JOB_RETRY_COUNT: Joi.number()
    .integer()
    .positive()
    .default(3),
  TENANT_PROVISIONING_JOB_TIMEOUT_MS: Joi.number()
    .integer()
    .positive()
    .default(60000),
  // SMTP is enabled by default in production so a deployment cannot silently
  // skip setup invitations. Development and test environments deliberately
  // default to disabled and can opt in with SMTP_ENABLED=true.
  SMTP_ENABLED: Joi.boolean().when('NODE_ENV', {
    is: 'production',
    then: Joi.boolean().valid(true).default(true),
    otherwise: Joi.boolean().default(false),
  }),
  // These values are required only when mail delivery is enabled. Keeping the
  // disabled path explicit makes isolated tests and local development
  // bootable without credentials, while production fails at startup when its
  // default-enabled transport is incomplete.
  SMTP_HOST: Joi.string().hostname().when('SMTP_ENABLED', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  SMTP_PORT: Joi.number().integer().min(1).max(65535).when('SMTP_ENABLED', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  SMTP_USERNAME: Joi.string().trim().min(1).when('SMTP_ENABLED', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  // Deliberately has no default: credentials must always be supplied by the
  // environment or secret manager, never checked into configuration.
  SMTP_PASSWORD: Joi.string().min(1).when('SMTP_ENABLED', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  SMTP_FROM: Joi.string().email().when('SMTP_ENABLED', {
    is: true,
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_TIMEOUT_MS: Joi.number().integer().positive().default(10000),
  // Public frontend origin used solely to construct the account-setup URL in
  // an SMTP message. It must never contain a token itself. Production setup
  // links must be HTTPS and their origin must be explicitly CORS-allowed.
  SETUP_ACCOUNT_URL_BASE: Joi.string()
    .custom(normalizeSetupAccountUrlBase)
    .when('NODE_ENV', {
      is: 'production',
      then: Joi.string().custom(requireHttps),
      otherwise: Joi.string(),
    })
    .default('http://localhost:5173')
    .messages({ 'any.custom': '{{#message}}' }),
})
  .custom((config, helpers) => {
    if (config.NODE_ENV !== 'production') {
      return config;
    }

    if (config.JWT_ACCESS_SECRET === config.JWT_REFRESH_SECRET) {
      return configurationError(
        helpers,
        'JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ in production',
      );
    }

    const corsOrigins = config.CORS_ORIGIN.split(',');
    if (!corsOrigins.includes(config.SETUP_ACCOUNT_URL_BASE)) {
      return configurationError(
        helpers,
        'SETUP_ACCOUNT_URL_BASE origin must be included in CORS_ORIGIN in production',
      );
    }

    return config;
  })
  .messages({ 'any.custom': '{{#message}}' });
