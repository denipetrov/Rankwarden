import { z } from 'zod';

import { REGIONS, type Region } from '../blizzard/blizzard.constants.js';
import {
  AGGREGATE_REGION,
  MAX_RUNS_PAGE,
  RAIDERIO_REGIONS,
  type RaiderIoRegion,
} from '../raiderio/raiderio.constants.js';

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
 * Comma-separated Raider.io regions.
 *
 * Its own validator rather than a reuse of `regionCsv`, because the two lists
 * genuinely differ: Raider.io serves `cn`, which the global Blizzard Game Data
 * API does not. It also rejects `world` by name - that pseudo-region is the
 * union of the real ones, so ingesting it alongside them would fetch every run
 * twice and leave the runs with no region of their own to be filtered by, and
 * the failure would look like duplicated data rather than a configuration
 * mistake.
 */
const raiderIoRegionCsv = (fallback: string) =>
  z
    .string()
    .default(fallback)
    .transform((value, ctx) => {
      const parts = split(value).map((part) => part.toLowerCase());

      if (parts.length === 0) {
        ctx.addIssue({ code: 'custom', message: 'must name at least one region' });
        return z.NEVER;
      }

      if (parts.includes(AGGREGATE_REGION)) {
        ctx.addIssue({
          code: 'custom',
          message:
            `"${AGGREGATE_REGION}" is the union of every other region, so ingesting it ` +
            'alongside them would store each run twice; list the real regions instead',
        });
        return z.NEVER;
      }

      const unknown = parts.filter(
        (part) => !(RAIDERIO_REGIONS as readonly string[]).includes(part),
      );

      if (unknown.length > 0) {
        ctx.addIssue({
          code: 'custom',
          message:
            `unknown region(s) ${unknown.join(', ')}; ` +
            `expected any of ${RAIDERIO_REGIONS.join(', ')}`,
        });
        return z.NEVER;
      }

      return [...new Set(parts)] as RaiderIoRegion[];
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
  /**
   * Upper bound on characters per enrichment run — a safety ceiling on memory
   * and run length, not the working batch. The working batch is computed each
   * run from how many characters are due and what the hourly quota share still
   * allows, and is only ever lowered by this.
   *
   * It has to sit comfortably above what the share needs, or it silently
   * becomes the binding limit: at the old 500, a specs-only pass bought 500
   * requests a run, 6,000 an hour — against ~6,800 an hour of steady demand at
   * 143k characters, so the queue was already on the edge of falling behind.
   */
  PROFILE_BATCH_SIZE: z.coerce.number().int().positive().default(2_000),
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

  // Raider.io - the Mythic+ upstream. Metered separately from Blizzard.
  /**
   * Application key from https://raider.io/settings/apps. Optional, because the
   * service runs perfectly well with Mythic+ switched off, and requiring it
   * would break every existing deployment at boot. `MPLUS_ENABLED` without a
   * key is rejected below, which is the case that actually matters.
   */
  RAIDER_IO_API_KEY: z.string().default(''),
  /** Base url. Exists so the integration harness can point at a dead port. */
  RAIDERIO_API_BASE_URL: z
    .string()
    .default('https://raider.io/api/v1')
    .refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
      message: 'must start with http:// or https://',
    })
    .transform(trimTrailingSlashes),
  /** Regions to ingest M+ runs for. Includes `cn`, which Blizzard's list cannot. */
  RAIDERIO_REGIONS: raiderIoRegionCsv('us,eu,kr,tw,cn'),
  RAIDERIO_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  RAIDERIO_RETRY_LIMIT: z.coerce.number().int().nonnegative().default(2),
  /** Pages fetched in parallel. At ~0.65s a page, 12 is ~18 pages a second. */
  RAIDERIO_CONCURRENCY: z.coerce.number().int().positive().default(12),
  /**
   * Pages fetched between budget checks and writes.
   *
   * The batch is what bounds memory: a page is 20 runs of 5 characters, so 50
   * pages is ~1,000 runs held before a write. It is also how often the
   * per-minute budget and the coordinator are re-consulted, which matters
   * because a full pass runs for minutes and both can change underneath it.
   */
  RAIDERIO_PAGE_BATCH: z.coerce.number().int().positive().default(50),
  /**
   * Pages per region per pass, counted from zero. The endpoint refuses `page`
   * above 1000, so 1001 is the whole leaderboard: 20,020 runs. Lower it to
   * trade coverage for time - `mythicScore` gets less complete as it falls.
   */
  RAIDERIO_MAX_PAGES: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_RUNS_PAGE + 1)
    .default(1_001),
  /**
   * Raider.io's cap, in requests a minute, across the whole client.
   *
   * Their documentation states 200/minute for unauthenticated callers and lifts
   * it for registered applications; a 300-request burst on the configured key
   * drew no 429, and no rate-limit header is exposed on a success, so this is
   * configuration rather than something readable from a response. Lower it if
   * 429s appear - the client honours `Retry-After`, but a budget that never
   * runs short is better than retries that do.
   */
  RAIDERIO_MINUTE_LIMIT: z.coerce.number().int().positive().default(1_000),
  /** Fraction of the cap ever planned against; the rest absorbs in-flight requests. */
  RAIDERIO_UTILISATION: z.coerce.number().positive().max(1).default(0.9),
  /**
   * Token bucket, paced to the per-minute ceiling. Kept a little under
   * `RAIDERIO_MINUTE_LIMIT x RAIDERIO_UTILISATION / 60` so a burst at the start
   * of a minute cannot spend the window before the budget notices.
   */
  RAIDERIO_REQUESTS_PER_SECOND: z.coerce.number().positive().default(14),
  /**
   * The most of each minute's usable budget the Mythic+ archive may spend.
   *
   * A cap, not a courtesy: the archive and the live pass draw from one
   * per-minute window, and the archive runs in exactly the gaps before a live
   * pass begins. Capped at half, a live pass always starts with at least half
   * the minute and has the rest within one window.
   */
  RAIDERIO_ARCHIVE_SHARE: z.coerce.number().positive().max(1).default(0.5),
  /**
   * How long a job waits for a spent minute to free before giving up.
   *
   * One window by default, which is always enough once lower-priority spend
   * has stopped. Zero restores the old behaviour of stopping on the spot, which
   * is what the test harness uses so a spent budget is observable without a
   * sixty-second sleep.
   */
  RAIDERIO_BUDGET_WAIT_MS: z.coerce.number().int().nonnegative().default(60_000),

  // Mythic+ ingestion.
  /**
   * Off by default, unlike every other job's flag.
   *
   * Mythic+ is the only job that needs a credential the service did not
   * previously have, so a default of on would stop an existing deployment from
   * booting the moment it took this build — the `RAIDER_IO_API_KEY` check below
   * would fire on configuration that was complete yesterday. Opting in is one
   * line next to the key it needs.
   */
  MPLUS_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * How often the M+ pass re-runs. A pass is ~1,001 requests a region, so at
   * five regions and six hours it is ~20,000 requests a day against a ceiling
   * of 1,000 a minute - the interval is chosen for how fast the ladder moves
   * and how much Mongo churn is reasonable, not for the quota.
   */
  MPLUS_INTERVAL_MS: z.coerce.number().int().positive().default(21_600_000),

  // Mythic+ archive of finished seasons.
  /**
   * Off by default for the same reason as `MPLUS_ENABLED`: it needs the
   * Raider.io key, which a deployment that predates Mythic+ does not have.
   */
  MPLUS_ARCHIVE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  /**
   * How often the archive looks for work. Cheap once history is in: a tick is
   * one indexed read, plus the catalogue refresh when that is due.
   */
  MPLUS_ARCHIVE_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /**
   * Pages of each region's board archived per season, counted from zero — the
   * same boards the live pass reads, one per `RAIDERIO_REGIONS` entry. 100 is
   * 2,000 runs a region, ~500 requests a season at five regions. Kept shallow:
   * the archive is a record of the top of each region's season, not a copy.
   */
  MPLUS_ARCHIVE_PAGES: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_RUNS_PAGE + 1)
    .default(100),
  /**
   * First expansion the catalogue walks from. The walk continues upward until an
   * expansion answers with no seasons, so a new expansion needs no change here.
   */
  MPLUS_CATALOGUE_FIRST_EXPANSION: z.coerce.number().int().positive().default(6),
  /**
   * How long the season catalogue is trusted before it is re-read.
   *
   * It has to be re-read at all because a season only becomes archivable when
   * it ends, and Raider.io lists a running season with a placeholder end
   * (`2030-01-01`) that it replaces with the real date afterwards. A catalogue
   * read once and never again would never see a season finish.
   */
  MPLUS_CATALOGUE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),

  // Mythic+ seasons: which one is current, and retiring the one it replaced.
  /**
   * Checks the Mythic+ season on its own schedule: the catalogue at boot and
   * whenever its TTL is up, and which season is current in each region. Idle
   * unless `MPLUS_ENABLED` or `MPLUS_ARCHIVE_ENABLED` is on. A live pass checks
   * for itself too, so switching this off delays noticing a transition rather
   * than breaking ingestion.
   */
  MPLUS_SEASON_REFRESH_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * How often. Hourly where the PvP check is daily, because a check here costs
   * no request unless the catalogue is due; this is how late a season opening
   * or ending is noticed when no pass runs first.
   */
  MPLUS_SEASON_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  MPLUS_TRANSITION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /** Fallback cadence; a detected rollover also ticks, once any running pass has finished. */
  MPLUS_TRANSITION_CHECK_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  /**
   * Only retire a superseded season once the Mythic+ archive holds it
   * (`complete`, or `unarchivable` when Raider.io refuses it). With the archive
   * switched off, nothing is ever retired while this is on.
   */
  MPLUS_PURGE_REQUIRE_ARCHIVE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  /**
   * Log the plan and delete nothing.
   *
   * Off by default, where `SEASON_PURGE_DRY_RUN` is on. The PvP default guards
   * a first deploy deleting every archived season at boot. Here the live pass
   * already deleted a superseded season the moment it rolled, with no archive
   * check at all, so there is no stored history to protect on a first deploy -
   * and a dry-run default would leave every rolled season in place until
   * someone remembered to flip it.
   */
  MPLUS_PURGE_DRY_RUN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  // Runtime.
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(['error', 'warn', 'log', 'debug', 'verbose']).default('log'),

  // Shared Blizzard quota. One hourly budget that every job draws from.
  /** Blizzard's documented cap on the whole client. */
  QUOTA_HOURLY_LIMIT: z.coerce.number().int().positive().default(36_000),
  /**
   * Fraction of the cap ever planned against. The rest absorbs requests already
   * in flight when a check is made, and retries on batches sized before they
   * failed — neither of which a budget can see coming.
   */
  QUOTA_UTILISATION: z.coerce.number().positive().max(1).default(0.9),
  /** Enrichment plans at most `QUOTA_HOURLY_LIMIT / this` requests an hour. */
  QUOTA_ENRICHMENT_HEADROOM: z.coerce.number().min(1).default(3),
  /**
   * Requests an hour held back for the sweep before anything else may spend.
   * A sweep is ~340 at four regions; this leaves room for its retries.
   */
  QUOTA_SWEEP_RESERVE: z.coerce.number().int().nonnegative().default(1_000),
});

/**
 * The shares have to fit inside what is usable, or the budget promises the
 * sweep and enrichment more than it can ever give them and the archive's
 * allowance is negative from the first request. A boot failure beats that.
 */
const validatedEnvSchema = envSchema.superRefine((env, ctx) => {
  const usable = Math.floor(env.QUOTA_HOURLY_LIMIT * env.QUOTA_UTILISATION);
  const promised =
    env.QUOTA_SWEEP_RESERVE + Math.floor(env.QUOTA_HOURLY_LIMIT / env.QUOTA_ENRICHMENT_HEADROOM);

  if (promised > usable) {
    ctx.addIssue({
      code: 'custom',
      path: ['QUOTA_SWEEP_RESERVE'],
      message:
        `the sweep reserve and enrichment share come to ${promised} requests an hour, ` +
        `more than the ${usable} that QUOTA_HOURLY_LIMIT x QUOTA_UTILISATION leaves usable`,
    });
  }

  // A key-less M+ job fails every request and reports an outage it caused
  // itself. Better to refuse to boot naming the variable.
  if (env.MPLUS_ARCHIVE_ENABLED && env.RAIDER_IO_API_KEY.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['RAIDER_IO_API_KEY'],
      message:
        'is required when MPLUS_ARCHIVE_ENABLED is true; set it or set MPLUS_ARCHIVE_ENABLED=false',
    });
  }

  if (env.MPLUS_ENABLED && env.RAIDER_IO_API_KEY.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['RAIDER_IO_API_KEY'],
      message: 'is required when MPLUS_ENABLED is true; set it or set MPLUS_ENABLED=false',
    });
  }

  // The token bucket and the per-minute budget have to agree, or one of them is
  // decorative. A bucket above the budget lets a burst spend the window before
  // the budget is next consulted; a bucket far below it means the budget can
  // never be reached and the real limit is the bucket, unreported.
  const raiderIoUsable = Math.floor(env.RAIDERIO_MINUTE_LIMIT * env.RAIDERIO_UTILISATION);
  const bucketPerMinute = env.RAIDERIO_REQUESTS_PER_SECOND * 60;

  if (bucketPerMinute > raiderIoUsable) {
    ctx.addIssue({
      code: 'custom',
      path: ['RAIDERIO_REQUESTS_PER_SECOND'],
      message:
        `${env.RAIDERIO_REQUESTS_PER_SECOND}/second is ${bucketPerMinute} requests a minute, ` +
        `more than the ${raiderIoUsable} that RAIDERIO_MINUTE_LIMIT x RAIDERIO_UTILISATION ` +
        'leaves usable',
    });
  }

  // A pass that cannot finish inside its own interval means each pass is still
  // running when the next is due, so the cadence in the configuration is not
  // the cadence in reality.
  const pagesPerPass = env.RAIDERIO_MAX_PAGES * env.RAIDERIO_REGIONS.length;
  const passMs = (pagesPerPass / Math.max(1, bucketPerMinute)) * 60_000;

  if (env.MPLUS_ENABLED && passMs > env.MPLUS_INTERVAL_MS) {
    ctx.addIssue({
      code: 'custom',
      path: ['MPLUS_INTERVAL_MS'],
      message:
        `a pass is ${pagesPerPass} pages, which at ${env.RAIDERIO_REQUESTS_PER_SECOND}/second ` +
        `takes about ${Math.round(passMs / 60_000)} minutes - longer than the ` +
        `${Math.round(env.MPLUS_INTERVAL_MS / 60_000)} minute interval it is given`,
    });
  }
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  const result = validatedEnvSchema.safeParse(raw);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }

  return result.data;
}
