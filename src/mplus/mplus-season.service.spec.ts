import { describe, expect, it } from 'vitest';

import { staticDataSchema } from '../raiderio/schemas/static-data.schema.js';
import { openRegions, pickCurrent } from './mplus-season.service.js';

/** The real `/mythic-plus/static-data?expansion_id=11` shape, trimmed. */
const seasons = staticDataSchema.parse({
  seasons: [
    {
      slug: 'season-mn-2',
      name: 'MN Season 2',
      blizzard_season_id: 18,
      is_main_season: true,
      starts: {
        us: '2026-08-18T15:00:00Z',
        eu: '2026-08-19T04:00:00Z',
        tw: '2026-08-19T23:00:00Z',
        kr: '2026-08-19T23:00:00Z',
        cn: '2026-08-19T23:00:00Z',
      },
      ends: { us: '2030-01-01T00:00:00Z' },
      dungeons: Array.from({ length: 8 }, (_unused, index) => ({
        id: index,
        slug: `dungeon-${index}`,
        name: `Dungeon ${index}`,
      })),
    },
    {
      slug: 'season-mn-1',
      name: 'MN Season 1',
      blizzard_season_id: 17,
      is_main_season: true,
      starts: { us: '2026-03-24T15:00:00Z' },
      ends: { us: '2026-08-18T15:00:00Z' },
      dungeons: [],
    },
    {
      slug: 'season-mn-1-break-the-meta',
      name: 'Break the Meta',
      blizzard_season_id: 17,
      is_main_season: false,
      starts: { us: '2026-07-14T15:00:00Z' },
      ends: { us: '2026-07-21T15:00:00Z' },
      dungeons: [],
    },
  ],
}).seasons;

describe('pickCurrent', () => {
  it('picks the newest main season that has already started', () => {
    const season = pickCurrent(seasons, new Date('2026-09-14T00:00:00Z'));

    expect(season?.slug).toBe('season-mn-2');
    expect(season?.seasonId, "Blizzard's M+ season id, not the PvP one").toBe(18);
    expect(season?.dungeons).toBe(8);
  });

  it('stays on the previous season until the new one opens anywhere', () => {
    // An hour before the US opening of season 2.
    const season = pickCurrent(seasons, new Date('2026-08-18T14:00:00Z'));

    expect(season?.slug).toBe('season-mn-1');
  });

  /**
   * `season-mn-1-break-the-meta` ran for a week inside season 1 with its own
   * slug and its own leaderboard. Picking it would have swapped the whole
   * ladder out for a week and swapped it back.
   */
  it('ignores a side event running inside a real season', () => {
    const season = pickCurrent(seasons, new Date('2026-07-16T00:00:00Z'));

    expect(season?.slug).toBe('season-mn-1');
  });

  it('takes the first main season listed when no timestamp parses', () => {
    const undated = seasons.map((season) => ({ ...season, starts: undefined }));

    expect(pickCurrent(undated, new Date())?.slug).toBe('season-mn-2');
  });
});

describe('openRegions', () => {
  const season = pickCurrent(seasons, new Date('2026-09-14T00:00:00Z'))!;

  it('skips regions the season has not reached yet', () => {
    // Regions stagger by up to 32 hours; the US is open, Europe is not.
    const open = openRegions(
      season,
      ['us', 'eu', 'kr', 'tw', 'cn'],
      new Date('2026-08-18T16:00:00Z'),
    );

    expect(open).toEqual(['us']);
  });

  it('returns every region once they have all opened', () => {
    const open = openRegions(
      season,
      ['us', 'eu', 'kr', 'tw', 'cn'],
      new Date('2026-09-14T00:00:00Z'),
    );

    expect(open).toEqual(['us', 'eu', 'kr', 'tw', 'cn']);
  });

  it('includes a region the payload says nothing about', () => {
    // Absent is not the same as "not started". Refusing to ingest a region
    // because a timestamp is missing would silently drop it.
    const open = openRegions({ ...season, startsAt: {} }, ['us', 'cn'], new Date(0));

    expect(open).toEqual(['us', 'cn']);
  });
});
