import { describe, expect, it } from 'vitest';

import { pvpSeasonIndexSchema } from './pvp-season.schema.js';

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
