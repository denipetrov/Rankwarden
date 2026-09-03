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
    expect(env.PROFILE_TTL_MS).toBe(86_400_000);
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
});
