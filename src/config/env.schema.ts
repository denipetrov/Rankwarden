import { z } from 'zod';

const csv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    );

/**
 * Every environment variable the service reads, validated once at boot.
 * Anything missing or malformed fails fast instead of surfacing mid-sweep.
 */
export const envSchema = z.object({
  // Blizzard OAuth — consumed by @denipetrov/blizz-auth.
  BLIZZARD_CLIENT_ID: z.string().min(1),
  BLIZZARD_CLIENT_SECRET: z.string().min(1),
  BLIZZARD_REGION: z.enum(['us', 'eu', 'kr', 'tw', 'cn']).default('us'),

  // Blizzard Game Data API.
  BLIZZARD_REGIONS: csv('us,eu,kr,tw'),
  BLIZZARD_LOCALE: z.string().default('en_US'),
  BLIZZARD_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  BLIZZARD_RETRY_LIMIT: z.coerce.number().int().nonnegative().default(3),
  BLIZZARD_CONCURRENCY: z.coerce.number().int().positive().default(4),

  // MongoDB.
  MONGODB_URI: z.string().min(1),
  MONGODB_DB: z.string().min(1).default('rankwarden'),

  // Ingestion cadence.
  INGEST_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  INGEST_RUN_ON_STARTUP: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

  // Profile enrichment (race, class, spec, hero talents).
  PROFILE_ENRICHMENT_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  PROFILE_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  PROFILE_BATCH_SIZE: z.coerce.number().int().positive().default(500),
  PROFILE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
  PROFILE_CONCURRENCY: z.coerce.number().int().positive().default(8),
  PROFILE_REQUESTS_PER_SECOND: z.coerce.number().positive().default(20),

  // Runtime.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
