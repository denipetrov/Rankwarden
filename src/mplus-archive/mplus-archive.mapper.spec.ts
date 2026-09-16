import { describe, expect, it } from 'vitest';

import { staticDataSchema } from '../raiderio/schemas/static-data.schema.js';
import type { MplusSeasonDocument } from './entities/mplus-archive.entity.js';
import {
  dungeonsOf,
  isFinished,
  mainSeasonsOf,
  pendingSeasons,
  toDungeonDocument,
  toSeasonDocument,
} from './mplus-archive.mapper.js';

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

describe('isFinished', () => {
  it('is finished only once every region has ended', () => {
    // Regions stagger by up to 32 hours. Archiving when the first closed would
    // freeze a board the others were still adding runs to — for good.
    const staggered = season('s', {
      ends: { us: new Date('2026-09-15T15:00:00Z'), eu: new Date('2026-09-17T04:00:00Z') },
    });

    expect(isFinished(staggered, now)).toBe(false);
    expect(isFinished(staggered, new Date('2026-09-18T00:00:00Z'))).toBe(true);
  });

  it("treats Raider.io's 2030 placeholder as a running season", () => {
    expect(isFinished(season('season-mn-2', { ends: { us: new Date('2030-01-01') } }), now)).toBe(
      false,
    );
  });

  it('is not finished with no end dates at all', () => {
    // A malformed payload must read as "wait", never as "archive now": an
    // archived season is never read again.
    expect(isFinished(season('s', { ends: {} }), now)).toBe(false);
  });
});

describe('pendingSeasons', () => {
  const complete = {
    status: 'complete' as const,
    pagesPlanned: 100,
    pagesFetched: 100,
    failedPages: [],
    runs: 2000,
    characters: 900,
    skippedRuns: 0,
    archivedAt: now,
    source: 'fetched' as const,
  };

  it('owes finished main seasons that have no marker, newest first', () => {
    const pending = pendingSeasons(
      [
        season('season-tww-1', { ends: { us: new Date('2025-02-25') } }),
        season('season-tww-3', { ends: { us: new Date('2026-03-02') } }),
        season('season-tww-2', { ends: { us: new Date('2025-08-12') } }),
      ],
      { now },
    );

    expect(pending.map((item) => item.slug)).toEqual([
      'season-tww-3',
      'season-tww-2',
      'season-tww-1',
    ]);
  });

  it('never owes a season already archived or known unarchivable', () => {
    const pending = pendingSeasons(
      [
        season('done', { archive: complete }),
        season('gone', { archive: { ...complete, status: 'unarchivable' } }),
        season('owed'),
      ],
      { now },
    );

    expect(pending.map((item) => item.slug)).toEqual(['owed']);
  });

  it('still owes an incomplete season, unless it is set aside for this tick', () => {
    const incomplete = season('flaky', {
      archive: { ...complete, status: 'incomplete', failedPages: [7] },
    });

    expect(pendingSeasons([incomplete], { now })).toHaveLength(1);
    expect(pendingSeasons([incomplete], { now, skip: new Set(['flaky']) })).toHaveLength(0);
  });

  it('never owes the running season', () => {
    const running = season('season-mn-2', { ends: { us: new Date('2030-01-01') } });

    expect(pendingSeasons([running], { now })).toHaveLength(0);
  });
});
