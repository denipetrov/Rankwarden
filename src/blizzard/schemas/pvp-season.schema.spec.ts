import { describe, expect, it } from 'vitest';

import { pvpSeasonIndexSchema, pvpSeasonSchema } from './pvp-season.schema.js';

describe('pvpSeasonIndexSchema', () => {
  it('accepts a season index payload and exposes the current season', () => {
    const parsed = pvpSeasonIndexSchema.parse({
      _links: { self: { href: 'https://us.api.blizzard.com/data/wow/pvp-season/index' } },
      seasons: [{ key: { href: 'https://…/pvp-season/41' }, id: 41 }, { id: 42 }],
      current_season: { id: 42 },
      last_completed_season: { id: 41 },
    });

    expect(parsed.current_season.id).toBe(42);
    expect(parsed.seasons).toHaveLength(2);
  });

  it('rejects a payload without a current season', () => {
    expect(() => pvpSeasonIndexSchema.parse({ seasons: [] })).toThrow();
  });
});

describe('pvpSeasonSchema', () => {
  const base = { id: 40, season_start_timestamp: 1755010800000 };

  it('reads the end timestamp once a season has finished', () => {
    const parsed = pvpSeasonSchema.parse({ ...base, season_end_timestamp: 1768888800000 });

    expect(parsed.season_end_timestamp).toBe(1768888800000);
  });

  it('accepts a running season, which carries no end timestamp', () => {
    expect(pvpSeasonSchema.parse(base).season_end_timestamp).toBeUndefined();
  });

  // All three shapes occur across real seasons: a string (39), absent (33), null (40).
  it('accepts a season name in every shape Blizzard returns', () => {
    expect(pvpSeasonSchema.parse({ ...base, season_name: 'Midnight Season 1' }).season_name).toBe(
      'Midnight Season 1',
    );
    expect(pvpSeasonSchema.parse(base).season_name).toBeUndefined();
    expect(pvpSeasonSchema.parse({ ...base, season_name: null }).season_name).toBeNull();
  });
});
