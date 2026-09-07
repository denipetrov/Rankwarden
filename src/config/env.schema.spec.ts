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

  it('leaves the season purge in dry run unless it is explicitly armed', () => {
    // On a first deploy mid-season the gate is already open, so the default has
    // to be the safe one.
    expect(validateEnv({ ...base }).SEASON_PURGE_DRY_RUN).toBe(true);
  });
});
