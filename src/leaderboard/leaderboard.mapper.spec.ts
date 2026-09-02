import { describe, expect, it } from 'vitest';

import type { PvpLeaderboard } from '../blizzard/schemas/pvp-leaderboard.schema.js';
import { toLeaderboardDocuments } from './leaderboard.mapper.js';

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

describe('toLeaderboardDocuments', () => {
  const fetchedAt = new Date('2026-09-02T00:00:00.000Z');
  const documents = toLeaderboardDocuments(leaderboard, {
    region: 'eu',
    bracket: '3v3',
    seasonId: 42,
    fetchedAt,
  });

  it('flattens character and realm into the document', () => {
    expect(documents[0]).toEqual({
      seasonId: 42,
      region: 'eu',
      bracket: '3v3',
      rank: 1,
      rating: 3000,
      characterId: 1,
      characterName: 'Warden',
      realmId: 60,
      realmSlug: 'tarren-mill',
      faction: 'HORDE',
      played: 100,
      won: 70,
      lost: 30,
      fetchedAt,
    });
  });

  it('defaults missing faction and match statistics', () => {
    expect(documents[1]).toMatchObject({ faction: null, played: 0, won: 0, lost: 0 });
  });
});
