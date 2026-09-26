import { describe, expect, it } from 'vitest';

import { validateEnv } from './env.schema.js';

const base = {
  BLIZZARD_CLIENT_ID: 'id',
  BLIZZARD_CLIENT_SECRET: 'secret',
  MONGODB_URI: 'mongodb://localhost:27017',
};

describe('validateEnv', () => {
  it('applies defaults for optional variables', () => {
    const env = validateEnv({ ...base });

    expect(env.BLIZZARD_REGIONS).toEqual(['us', 'eu', 'kr', 'tw']);
    expect(env.PROFILE_SUMMARY_TTL_MS).toBe(604_800_000);
    expect(env.PROFILE_SPECS_TTL_MS).toBe(86_400_000);
    expect(env.PROFILE_ENRICHMENT_ENABLED).toBe(true);
    expect(env.INGEST_RUN_ON_STARTUP).toBe(true);
    expect(env.PORT).toBe(3000);
  });

  it('parses the region list into lowercase entries', () => {
    const env = validateEnv({ ...base, BLIZZARD_REGIONS: 'US, EU ' });

    expect(env.BLIZZARD_REGIONS).toEqual(['us', 'eu']);
  });

  it('throws with the offending variable named', () => {
    expect(() => validateEnv({ ...base, BLIZZARD_CLIENT_ID: '' })).toThrow(/BLIZZARD_CLIENT_ID/);
  });

  it('rejects an unknown region instead of quietly dropping it', () => {
    // A typo used to parse, then get filtered out by isRegion in four separate
    // services, so ingestion covered fewer regions than configured in silence.
    expect(() => validateEnv({ ...base, BLIZZARD_REGIONS: 'us,eur' })).toThrow(
      /BLIZZARD_REGIONS[\s\S]*eur/,
    );
  });

  it('rejects an empty region list', () => {
    expect(() => validateEnv({ ...base, BLIZZARD_REGIONS: ' , ' })).toThrow(/BLIZZARD_REGIONS/);
  });

  it('rejects a non-numeric rating cutoff instead of yielding an empty list', () => {
    // Filtering left [] behind, and the snapshot job then ran forever writing
    // nothing while logging success.
    expect(() => validateEnv({ ...base, REPRESENTATION_MIN_RATINGS: '1500,l800' })).toThrow(
      /REPRESENTATION_MIN_RATINGS[\s\S]*l800/,
    );
  });

  it('sorts and de-duplicates the rating cutoffs', () => {
    const env = validateEnv({ ...base, REPRESENTATION_MIN_RATINGS: '2100, 1500,1500 ' });

    expect(env.REPRESENTATION_MIN_RATINGS).toEqual([1500, 2100]);
  });

  it('defaults the API host template to production', () => {
    expect(validateEnv({ ...base }).BLIZZARD_API_HOST_TEMPLATE).toBe(
      'https://{region}.api.blizzard.com',
    );
  });

  it('requires the region placeholder in a host override', () => {
    expect(() =>
      validateEnv({ ...base, BLIZZARD_API_HOST_TEMPLATE: 'http://localhost:8080' }),
    ).toThrow(/BLIZZARD_API_HOST_TEMPLATE/);
  });

  it('accepts a localhost template and trims its trailing slash', () => {
    const env = validateEnv({
      ...base,
      BLIZZARD_API_HOST_TEMPLATE: 'http://localhost:8080/{region}/',
    });

    expect(env.BLIZZARD_API_HOST_TEMPLATE).toBe('http://localhost:8080/{region}');
  });

  it('reads the season transition booleans as booleans, not as truthy strings', () => {
    // z.coerce.boolean() would read the string "false" as true, which on this
    // flag means arming an irreversible delete by accident.
    const env = validateEnv({ ...base, SEASON_PURGE_DRY_RUN: 'false' });

    expect(env.SEASON_PURGE_DRY_RUN).toBe(false);
    expect(env.SEASON_TRANSITION_ENABLED).toBe(true);
    expect(env.SEASON_PURGE_REQUIRE_ARCHIVE).toBe(true);
  });

  it('retries per-character endpoints less than everything else', () => {
    // Enrichment scales with the population, not the bracket count: at the
    // defaults it is 12,000 requests an hour before a single retry, against a
    // 36,000/hour quota.
    const env = validateEnv({ ...base });

    expect(env.PROFILE_RETRY_LIMIT).toBe(1);
    expect(env.PROFILE_RETRY_LIMIT).toBeLessThan(env.BLIZZARD_RETRY_LIMIT);
  });

  it('allows retries to be switched off entirely for profiles', () => {
    expect(validateEnv({ ...base, PROFILE_RETRY_LIMIT: '0' }).PROFILE_RETRY_LIMIT).toBe(0);
  });

  it('rejects a negative retry limit', () => {
    expect(() => validateEnv({ ...base, PROFILE_RETRY_LIMIT: '-1' })).toThrow(
      /PROFILE_RETRY_LIMIT/,
    );
  });

  it('defaults the shared quota to Blizzard cap and a third for enrichment', () => {
    const env = validateEnv({ ...base });

    expect(env.QUOTA_HOURLY_LIMIT).toBe(36_000);
    expect(env.QUOTA_UTILISATION).toBe(0.9);
    expect(env.QUOTA_ENRICHMENT_HEADROOM).toBe(3);
    expect(env.QUOTA_SWEEP_RESERVE).toBe(1_000);
  });

  it('treats PROFILE_BATCH_SIZE as a ceiling well above what the share needs', () => {
    // At 500 the batch, not the quota, was the binding limit — see quota.spec.ts.
    expect(validateEnv({ ...base }).PROFILE_BATCH_SIZE).toBe(2_000);
  });

  it('refuses shares that promise more than the budget can give', () => {
    // A sweep reserve plus an enrichment share larger than what is usable
    // would leave the archive a negative allowance from the first request.
    expect(() =>
      validateEnv({ ...base, QUOTA_SWEEP_RESERVE: '25000', QUOTA_ENRICHMENT_HEADROOM: '3' }),
    ).toThrow(/QUOTA_SWEEP_RESERVE[\s\S]*more than the 32400/);
  });

  it('refuses a utilisation above the whole cap', () => {
    expect(() => validateEnv({ ...base, QUOTA_UTILISATION: '1.2' })).toThrow(/QUOTA_UTILISATION/);
  });

  it('refuses a headroom that would give enrichment more than the whole hour', () => {
    expect(() => validateEnv({ ...base, QUOTA_ENRICHMENT_HEADROOM: '0.5' })).toThrow(
      /QUOTA_ENRICHMENT_HEADROOM/,
    );
  });

  it('leaves the season purge in dry run unless it is explicitly armed', () => {
    // On a first deploy mid-season the gate is already open, so the default has
    // to be the safe one.
    expect(validateEnv({ ...base }).SEASON_PURGE_DRY_RUN).toBe(true);
  });
});

/**
 * M1.5 / M10.9 — every Mythic+ environment rule. A key-less job, a region list
 * that would double-ingest, and a cadence that cannot be kept are all refused
 * at boot, naming the variable, rather than discovered as an outage.
 */
describe('validateEnv — Mythic+', () => {
  const key = { RAIDER_IO_API_KEY: 'rio-key' };
  const issues = (raw: Record<string, unknown>) => {
    try {
      validateEnv({ ...base, ...raw });
    } catch (error) {
      return (error as Error).message.split('\n').slice(1);
    }

    return [];
  };

  it('refuses the live pass without a key, naming the key and the switch', () => {
    expect(issues({ MPLUS_ENABLED: 'true' })).toEqual([
      '  - RAIDER_IO_API_KEY: is required when MPLUS_ENABLED is true; set it or set MPLUS_ENABLED=false',
    ]);
  });

  it('refuses the archive without a key, naming its own switch', () => {
    expect(issues({ MPLUS_ARCHIVE_ENABLED: 'true' })).toEqual([
      '  - RAIDER_IO_API_KEY: is required when MPLUS_ARCHIVE_ENABLED is true; set it or set MPLUS_ARCHIVE_ENABLED=false',
    ]);
  });

  it('reports both when both are on without a key', () => {
    expect(issues({ MPLUS_ENABLED: 'true', MPLUS_ARCHIVE_ENABLED: 'true' })).toHaveLength(2);
  });

  it('needs no key with both off, which is every deployment that predates them', () => {
    const env = validateEnv({ ...base });

    expect(env.MPLUS_ENABLED).toBe(false);
    expect(env.MPLUS_ARCHIVE_ENABLED).toBe(false);
    expect(env.RAIDER_IO_API_KEY).toBe('');
  });

  it.each([
    [
      'world, the union of every other region',
      'us,world',
      /RAIDERIO_REGIONS: "world" is the union/,
    ],
    ['an unknown region', 'us,eur', /RAIDERIO_REGIONS: unknown region\(s\) eur/],
    ['an empty list', ' , ', /RAIDERIO_REGIONS: must name at least one region/],
  ])('rejects %s in RAIDERIO_REGIONS', (_name, value, message) => {
    expect(() => validateEnv({ ...base, RAIDERIO_REGIONS: value })).toThrow(message);
  });

  it('lowers and de-duplicates the region list', () => {
    expect(validateEnv({ ...base, RAIDERIO_REGIONS: 'US, eu ,us,CN' }).RAIDERIO_REGIONS).toEqual([
      'us',
      'eu',
      'cn',
    ]);
  });

  it.each([
    ['a page past the endpoint cap', { RAIDERIO_MAX_PAGES: '1002' }, /RAIDERIO_MAX_PAGES/],
    ['an archive of no pages', { MPLUS_ARCHIVE_PAGES: '0' }, /MPLUS_ARCHIVE_PAGES/],
    [
      'an archive share above the whole minute',
      { RAIDERIO_ARCHIVE_SHARE: '1.5' },
      /RAIDERIO_ARCHIVE_SHARE/,
    ],
    [
      'a base url with no scheme',
      { RAIDERIO_API_BASE_URL: 'raider.io/api/v1' },
      /RAIDERIO_API_BASE_URL: must start with http/,
    ],
  ])('rejects %s', (_name, raw, message) => {
    expect(() => validateEnv({ ...base, ...raw })).toThrow(message);
  });

  it('accepts the full board, 1,001 pages, and trims a trailing slash off the base url', () => {
    const env = validateEnv({
      ...base,
      RAIDERIO_MAX_PAGES: '1001',
      RAIDERIO_API_BASE_URL: 'http://127.0.0.1:9/api/v1/',
    });

    expect(env.RAIDERIO_MAX_PAGES).toBe(1_001);
    expect(env.RAIDERIO_API_BASE_URL).toBe('http://127.0.0.1:9/api/v1');
  });

  it('rejects a token bucket faster than the usable minute', () => {
    // 16 a second is 960 a minute; 1,000 x 0.9 leaves 900.
    expect(issues({ RAIDERIO_REQUESTS_PER_SECOND: '16' })).toEqual([
      expect.stringMatching(
        /RAIDERIO_REQUESTS_PER_SECOND: 16\/second is 960 requests a minute, more than the 900/,
      ),
    ]);
    expect(issues({ RAIDERIO_REQUESTS_PER_SECOND: '15' })).toEqual([]);
  });

  it('rejects a pass longer than its interval, but only while the pass is on', () => {
    // 5,005 pages at 14 a second is about six minutes.
    const tooShort = { ...key, MPLUS_INTERVAL_MS: '60000' };

    expect(issues({ ...tooShort, MPLUS_ENABLED: 'true' })).toEqual([
      expect.stringMatching(/MPLUS_INTERVAL_MS: a pass is 5005 pages, .* about 6 minutes/),
    ]);
    expect(issues(tooShort), 'nothing to keep a cadence for').toEqual([]);
  });
});
