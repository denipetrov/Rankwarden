import { describe, expect, it } from 'vitest';

import type { PvpLeaderboard } from '../blizzard/schemas/pvp-leaderboard.schema.js';
import { toCharacterBracketUpdates } from './leaderboard.mapper.js';

const leaderboard: PvpLeaderboard = {
  season: { id: 42 },
  name: '3v3',
  bracket: { id: 2, type: 'ARENA_3v3' },
  entries: [
    {
      character: { id: 1, name: 'Warden', realm: { id: 60, slug: 'tarren-mill' } },
      faction: { type: 'HORDE' },
      rank: 1,
      rating: 3000,
      season_match_statistics: { played: 100, won: 70, lost: 30 },
    },
    {
      character: { id: 2, name: 'Nostats', realm: { id: 61, slug: 'kazzak' } },
      rank: 2,
      rating: 2900,
    },
  ],
};

describe('toCharacterBracketUpdates', () => {
  const fetchedAt = new Date('2026-09-02T00:00:00.000Z');
  const updates = toCharacterBracketUpdates(leaderboard, {
    region: 'eu',
    bracket: '3v3',
    seasonId: 42,
    fetchedAt,
  });

  it('separates character identity from bracket standing', () => {
    expect(updates[0]).toEqual({
      seasonId: 42,
      region: 'eu',
      characterId: 1,
      characterName: 'Warden',
      realmId: 60,
      realmSlug: 'tarren-mill',
      faction: 'HORDE',
      bracket: '3v3',
      stats: { rank: 1, rating: 3000, played: 100, won: 70, lost: 30, fetchedAt },
    });
  });

  it('defaults missing faction and match statistics', () => {
    expect(updates[1]).toMatchObject({
      faction: null,
      stats: { played: 0, won: 0, lost: 0 },
    });
  });

  it('stamps every update with the sweep timestamp', () => {
    expect(updates.every((update) => update.stats.fetchedAt === fetchedAt)).toBe(true);
  });
});
