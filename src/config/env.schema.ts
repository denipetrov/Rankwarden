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
  BLIZZARD_CONCURRENCY: z.coerce.number().int().positive().default(8),

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
  /** Race, class, realm, title — changes rarely, so refreshed weekly. */
  PROFILE_SUMMARY_TTL_MS: z.coerce.number().int().positive().default(604_800_000),
  /** Spec and hero talents — moves whenever a player respecs. */
  PROFILE_SPECS_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
  PROFILE_CONCURRENCY: z.coerce.number().int().positive().default(8),
  PROFILE_REQUESTS_PER_SECOND: z.coerce.number().positive().default(20),

  /** How often to re-check which season is active, independently of sweeps. */
  SEASON_REFRESH_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),

  // Archive of finished seasons.
  ARCHIVE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  ARCHIVE_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** Breather between seasons so a backfill does not monopolise the quota. */
  ARCHIVE_SEASON_PAUSE_MS: z.coerce.number().int().nonnegative().default(5_000),
  ARCHIVE_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** Top N by rating kept per bracket. Blizzard already returns about this many. */
  ARCHIVE_MAX_ENTRIES_PER_BRACKET: z.coerce.number().int().positive().default(5_000),
  /**
   * Oldest season to archive; 0 means every season Blizzard still serves. The
   * full history is roughly 20M rows / 5GB, so this is the knob for trading
   * completeness against disk.
   */
  ARCHIVE_MIN_SEASON: z.coerce.number().int().nonnegative().default(0),
  /** Newest season to archive; 0 means no upper bound. Pairs with the minimum
   * to target a single season or a range. */
  ARCHIVE_MAX_SEASON: z.coerce.number().int().nonnegative().default(0),
  ARCHIVE_REQUESTS_PER_SECOND: z.coerce.number().positive().default(10),

  // Daily spec-representation snapshots ("flavour of the month").
  REPRESENTATION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  REPRESENTATION_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** Rating cutoffs to track. */
  REPRESENTATION_MIN_RATINGS: z
    .string()
    .default('1500,1800,2100,2300,2700')
    .transform((value) =>
      value
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isInteger(value) && value >= 0),
    ),

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
