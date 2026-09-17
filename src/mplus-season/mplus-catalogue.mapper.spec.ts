import { describe, expect, it } from 'vitest';

import { staticDataSchema } from '../raiderio/schemas/static-data.schema.js';
import type { MplusSeasonDocument } from './entities/mplus-season.entity.js';
import {
  currentSeasonIn,
  dungeonsOf,
  isArchiveSettled,
  mainSeasonsOf,
  startIn,
  toDungeonDocument,
  toSeasonDocument,
} from './mplus-catalogue.mapper.js';

const now = new Date('2026-09-16T00:00:00Z');

function season(slug: string, overrides: Partial<MplusSeasonDocument> = {}): MplusSeasonDocument {
  return {
    slug,
    name: slug,
    shortName: null,
    expansionId: 10,
    blizzardSeasonId: 15,
    starts: { us: new Date('2025-08-12T15:00:00Z') },
    ends: { us: new Date('2026-03-02T22:00:00Z'), eu: new Date('2026-03-03T04:00:00Z') },
    dungeonIds: [],
    catalogueUpdatedAt: now,
    ...overrides,
  };
}

/** Trimmed from the live `static-data?expansion_id=6` payload of 2026-09-16. */
const legion = staticDataSchema.parse({
  seasons: [
    {
      slug: 'season-7.2.0',
      name: 'Legion Season 2',
      blizzard_season_id: 0,
      is_main_season: true,
      short_name: 'L2',
      seasonal_affix: null,
      starts: { us: '2017-03-28T15:00:00Z', eu: '2017-03-29T07:00:00Z' },
      ends: { us: '2017-06-13T15:00:00Z', eu: '2017-06-14T07:00:00Z' },
      dungeons: [
        {
          id: 7805,
          challenge_mode_id: 199,
          slug: 'black-rook-hold',
          name: 'Black Rook Hold',
          short_name: 'BRH',
          keystone_timer_seconds: 2340,
          icon_url: 'https://cdn.raiderio.net/brh.jpg',
          background_image_url: 'https://cdn.raiderio.net/brh-bg.jpg',
        },
        { id: 8079, slug: 'court-of-stars', name: 'Court of Stars', short_name: 'COS' },
      ],
    },
    {
      slug: 'season-post-legion',
      name: 'Post-Legion',
      blizzard_season_id: 0,
      is_main_season: false,
      starts: { us: '2018-06-26T15:00:00Z' },
      ends: { us: '2018-07-17T15:00:00Z' },
      dungeons: [{ id: 7805, slug: 'black-rook-hold', name: 'Black Rook Hold' }],
    },
  ],
});

describe('toSeasonDocument', () => {
  it('parses per-region dates and references dungeons by id', () => {
    const document = toSeasonDocument(legion.seasons[0], 6, now);

    expect(document.expansionId).toBe(6);
    expect(document.ends.eu).toEqual(new Date('2017-06-14T07:00:00Z'));
    expect(document.dungeonIds).toEqual([7805, 8079]);
    // Legion predates Blizzard numbering its M+ seasons: every one reads 0.
    expect(document.blizzardSeasonId).toBe(0);
  });

  it('never carries an archive marker, so a refresh cannot overwrite one', () => {
    expect(toSeasonDocument(legion.seasons[0], 6, now)).not.toHaveProperty('archive');
  });

  it('drops a timestamp it cannot parse rather than storing an invalid date', () => {
    const document = toSeasonDocument(
      { ...legion.seasons[0], ends: { us: 'not a date', eu: '2017-06-14T07:00:00Z' } },
      6,
      now,
    );

    expect(Object.keys(document.ends)).toEqual(['eu']);
  });
});

describe('mainSeasonsOf', () => {
  it('keeps main seasons and drops side events', () => {
    expect(mainSeasonsOf(legion.seasons).map((item) => item.slug)).toEqual(['season-7.2.0']);
  });

  it('reads a season with no flag as main rather than dropping it', () => {
    // Every season observed carries the flag. Guessing "side event" for one that
    // did not would drop a real season from the catalogue and the archive.
    const unflagged = { ...legion.seasons[0], is_main_season: undefined };

    expect(mainSeasonsOf([unflagged])).toHaveLength(1);
  });

  it('loses no dungeon when only main seasons are kept', () => {
    // Post-Legion lists only Black Rook Hold, which season 7.2.0 lists too — the
    // shape of the real catalogue, where the 21 main seasons cover all 74.
    const fromAll = dungeonsOf(legion.seasons).map((dungeon) => dungeon.id);
    const fromMain = dungeonsOf(mainSeasonsOf(legion.seasons)).map((dungeon) => dungeon.id);

    expect([...fromMain].sort()).toEqual([...fromAll].sort());
  });
});

describe('dungeonsOf / toDungeonDocument', () => {
  it('lists each dungeon once however many seasons ran it', () => {
    expect(dungeonsOf(legion.seasons).map((dungeon) => dungeon.id)).toEqual([7805, 8079]);
  });

  it('keeps the art and timer fields, and nulls the ones a payload omits', () => {
    const [blackRook, court] = dungeonsOf(legion.seasons).map((dungeon) =>
      toDungeonDocument(dungeon, now),
    );

    // The later, sparser listing of Black Rook Hold wins the dedupe; the full
    // one is asserted through the season that carries it instead.
    expect(blackRook.id).toBe(7805);
    expect(court.iconUrl).toBeNull();
    expect(toDungeonDocument(legion.seasons[0].dungeons![0], now).keystoneTimerSeconds).toBe(2340);
  });
});

describe('startIn', () => {
  it("reads the region's own start", () => {
    const staggered = season('s', {
      starts: { us: new Date('2026-08-18T15:00:00Z'), eu: new Date('2026-08-19T04:00:00Z') },
    });

    expect(startIn(staggered, 'eu')).toEqual(new Date('2026-08-19T04:00:00Z'));
  });

  it('falls back to the earliest start for a region the season does not list', () => {
    // Absent is not "never": refusing a region for a missing timestamp would
    // silently stop ingesting it.
    const partial = season('s', {
      starts: { eu: new Date('2026-08-19T04:00:00Z'), us: new Date('2026-08-18T15:00:00Z') },
    });

    expect(startIn(partial, 'cn')).toEqual(new Date('2026-08-18T15:00:00Z'));
  });

  it('has no start when the season lists none anywhere', () => {
    expect(startIn(season('s', { starts: {} }), 'us')).toBeNull();
  });
});

describe('currentSeasonIn', () => {
  const mn1 = season('season-mn-1', {
    expansionId: 11,
    starts: { us: new Date('2026-03-24T15:00:00Z'), eu: new Date('2026-03-25T04:00:00Z') },
    ends: { us: new Date('2026-08-18T15:00:00Z'), eu: new Date('2026-08-19T04:00:00Z') },
  });
  const mn2 = season('season-mn-2', {
    expansionId: 11,
    starts: { us: new Date('2026-08-18T15:00:00Z'), eu: new Date('2026-08-19T04:00:00Z') },
    ends: { us: new Date('2030-01-01T00:00:00Z'), eu: new Date('2030-01-01T00:00:00Z') },
  });

  it('picks the season that most recently opened in the region', () => {
    expect(currentSeasonIn([mn1, mn2], 'us', now)?.slug).toBe('season-mn-2');
  });

  it('keeps each region on its own season while the opening staggers', () => {
    // Between the US and the European openings of season 2.
    const at = new Date('2026-08-18T20:00:00Z');

    expect(currentSeasonIn([mn1, mn2], 'us', at)?.slug).toBe('season-mn-2');
    expect(currentSeasonIn([mn1, mn2], 'eu', at)?.slug, 'Europe has not opened it yet').toBe(
      'season-mn-1',
    );
  });

  it('keeps an ended season current until its successor opens', () => {
    // Season 1 ended in Europe on the 19th. Had season 2 opened there only on
    // the 21st, season 1 is still the board to read on the 20th.
    const lateSuccessor = { ...mn2, starts: { eu: new Date('2026-08-21T04:00:00Z') } };

    expect(
      currentSeasonIn([mn1, lateSuccessor], 'eu', new Date('2026-08-20T00:00:00Z'))?.slug,
    ).toBe('season-mn-1');
  });

  it('decides on start dates, never on the order seasons are listed', () => {
    expect(currentSeasonIn([mn2, mn1], 'us', now)?.slug).toBe('season-mn-2');
  });

  it('never picks a season that has not opened anywhere', () => {
    const announced = season('season-mn-3', {
      expansionId: 11,
      starts: { us: new Date('2027-01-19T15:00:00Z') },
    });

    expect(currentSeasonIn([mn1, mn2, announced], 'us', now)?.slug).toBe('season-mn-2');
  });

  it('never picks a season with no start date', () => {
    // An undated season cannot be placed against the others, and switching the
    // ladder on a guess is worse than staying on the season that is dated.
    expect(currentSeasonIn([season('undated', { starts: {} })], 'us', now)).toBeNull();
  });

  it('is null for a region no catalogued season has opened in', () => {
    expect(currentSeasonIn([], 'us', now)).toBeNull();
  });
});

describe('isArchiveSettled', () => {
  const marker = {
    pagesPlanned: 100,
    pagesFetched: 100,
    failedPages: [],
    runs: 2000,
    characters: 900,
    skippedRuns: 0,
    archivedAt: now,
    source: 'fetched' as const,
  };

  it('is settled once complete, or refused for good', () => {
    expect(isArchiveSettled(season('s', { archive: { ...marker, status: 'complete' } }))).toBe(
      true,
    );
    expect(isArchiveSettled(season('s', { archive: { ...marker, status: 'unarchivable' } }))).toBe(
      true,
    );
  });

  it('is not settled while a page is outstanding, or before the archive has tried', () => {
    expect(isArchiveSettled(season('s', { archive: { ...marker, status: 'incomplete' } }))).toBe(
      false,
    );
    expect(isArchiveSettled(season('s'))).toBe(false);
  });
});
