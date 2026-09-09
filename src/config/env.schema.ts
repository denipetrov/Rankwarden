import { z } from 'zod';

import { REGIONS, type Region } from '../blizzard/blizzard.constants.js';

const split = (value: string) =>
  value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const trimTrailingSlashes = (value: string) => {
  let trimmed = value;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);

  return trimmed;
};

/**
 * Comma-separated regions, every one of which must be a region we actually
 * serve. Previously a free-form list filtered by `isRegion` at four separate
 * call sites, so `us,eur` booted reporting two regions and ingested one. A typo
 * in the deployment config is a boot failure, not a silent halving of coverage.
 */
const regionCsv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const parts = split(value).map((part) => part.toLowerCase());

      if (parts.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'must name at least one region' });
        return z.NEVER;
      }

      const unknown = parts.filter((part) => !(REGIONS as readonly string[]).includes(part));

      if (unknown.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `unknown region(s) ${unknown.join(', ')}; expected any of ${REGIONS.join(', ')}`,
        });
        return z.NEVER;
      }

      return [...new Set(parts)] as Region[];
    });

/**
 * Comma-separated non-negative integers. Non-numeric entries used to be
 * filtered out silently, so a typo produced an empty cutoff list and the
 * snapshot job ran forever writing nothing while logging success.
 */
const integerCsv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const parts = split(value);

      if (parts.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'must list at least one value' });
        return z.NEVER;
      }

      const invalid = parts.filter((part) => {
        const parsed = Number(part);

        return !Number.isInteger(parsed) || parsed < 0;
      });

      if (invalid.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message: `expected comma-separated non-negative integers, got ${invalid.join(', ')}`,
        });
        return z.NEVER;
      }

      return [...new Set(parts.map(Number))].sort((left, right) => left - right);
    });

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
  BLIZZARD_REGIONS: regionCsv('us,eu,kr,tw'),
  /**
   * Host template for the Game Data API; `{region}` is substituted per call.
   * Exists so a runtime rehearsal can point a running binary at a fake server.
   * Left unset it produces exactly the production URLs.
   */
  BLIZZARD_API_HOST_TEMPLATE: z
    .string()
    .default('https://{region}.api.blizzard.com')
    .refine((value) => value.includes('{region}'), {
      message: 'must contain the {region} placeholder',
    })
    .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
      message: 'must start with http:// or https://',
    })
    .transform(trimTrailingSlashes),
  BLIZZARD_LOCALE: z.string().default('en_US'),
  BLIZZARD_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  BLIZZARD_RETRY_LIMIT: z.coerce.number().int().nonnegative().default(3),
  /**
   * Retries for the per-character profile endpoints, which are the ones that
   * scale with the population rather than with the bracket count.
   *
   * Deliberately lower than `BLIZZARD_RETRY_LIMIT`. At the defaults a pass is
   * 500 characters x 2 requests every 5 minutes — 12,000 requests an hour
   * before a single retry, against a 36,000/hour quota. Retrying each of those
   * three times turns a degraded upstream into 48,000 and puts enrichment alone
   * over the cap, starving the sweep that actually serves the boards. A ladder
   * fetch is worth several attempts because there are only ~332 of them; a
   * character is not.
   */
  PROFILE_RETRY_LIMIT: z.coerce.number().int().nonnegative().default(1),
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
  /**
   * How long a character waits after a transient enrichment failure before it
   * is eligible again. Short, because the data is fine and only the fetch
   * failed — but non-zero, because a character that is never stamped sorts
   * ahead of everything forever and starves the queue.
   */
  PROFILE_RETRY_BACKOFF_MS: z.coerce.number().int().positive().default(900_000),
  PROFILE_REQUESTS_PER_SECOND: z.coerce.number().positive().default(20),

  /** Every other scheduler has an off switch; this one needs it for the same
   * reason, so a test or a rehearsal can boot without it calling out. */
  SEASON_REFRESH_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** How often to re-check which season is active, independently of sweeps. */
  SEASON_REFRESH_INTERVAL_MS: z.coerce.number().int().positive().default(86_400_000),

  // Season transition: retiring a finished season from the live collections.
  SEASON_TRANSITION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** Fallback cadence; a detected rollover also ticks immediately. */
  SEASON_TRANSITION_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /** Only purge a season the archive already holds in full. */
  SEASON_PURGE_REQUIRE_ARCHIVE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * Log the full plan at warn level and delete nothing.
   *
   * Defaults to ON, unlike the other flags. On a first deploy mid-season the
   * purge gate is already open — `transitionAt` is the current season's start,
   * which is in the past — so a live default would delete every archived season
   * below the current one at boot, before anyone had seen a plan. Deleting is
   * therefore an explicit opt-in.
   */
  SEASON_PURGE_DRY_RUN: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),

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
  REPRESENTATION_MIN_RATINGS: integerCsv('1500,1800,2100,2300,2700'),

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
