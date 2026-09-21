import { describe, expect, it } from 'vitest';

import type {
  MplusSeasonArchiveMarker,
  MplusSeasonDocument,
} from '../mplus-season/entities/mplus-season.entity.js';
import { isFinished, pendingSeasons, regionsOwed } from './mplus-archive.mapper.js';

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

const regionDone = {
  status: 'complete' as const,
  pagesFetched: 100,
  failedPages: [],
  runs: 2000,
  characters: 900,
  archivedAt: now,
  source: 'fetched' as const,
};

const complete = {
  status: 'complete' as const,
  pagesPlanned: 100,
  pagesFetched: 200,
  failedPages: [] as string[],
  runs: 4000,
  characters: 1800,
  regions: { us: regionDone, eu: regionDone },
  archivedAt: now,
  source: 'fetched' as const,
};

const REGIONS = ['us', 'eu'] as const;

describe('regionsOwed', () => {
  it('owes every region for a season never tried', () => {
    expect(regionsOwed(season('s'), REGIONS)).toEqual(['us', 'eu']);
  });

  it('owes only the regions not complete', () => {
    const halfway = season('s', {
      archive: {
        ...complete,
        status: 'incomplete',
        regions: { us: regionDone, eu: { ...regionDone, status: 'incomplete', failedPages: [7] } },
      },
    });

    expect(regionsOwed(halfway, REGIONS)).toEqual(['eu']);
  });

  it('owes every region for a season archived from the world board, which has no regions', () => {
    // Written by the earlier archive. It proves nothing about any one region's
    // board, so each is read again.
    const legacy = season('s', {
      archive: { ...complete, regions: undefined } as unknown as MplusSeasonArchiveMarker,
    });

    expect(regionsOwed(legacy, REGIONS)).toEqual(['us', 'eu']);
  });

  it('owes a region added to the configuration after the season was archived', () => {
    const archived = season('s', { archive: complete });

    expect(regionsOwed(archived, ['us', 'eu', 'kr'])).toEqual(['kr']);
  });
});

describe('pendingSeasons', () => {
  it('owes finished main seasons that have no marker, newest first', () => {
    const pending = pendingSeasons(
      [
        season('season-tww-1', { ends: { us: new Date('2025-02-25') } }),
        season('season-tww-3', { ends: { us: new Date('2026-03-02') } }),
        season('season-tww-2', { ends: { us: new Date('2025-08-12') } }),
      ],
      { now, regions: REGIONS },
    );

    expect(pending.map((item) => item.slug)).toEqual([
      'season-tww-3',
      'season-tww-2',
      'season-tww-1',
    ]);
  });

  it('never owes a season archived in every region, or known unarchivable', () => {
    const pending = pendingSeasons(
      [
        season('done', { archive: complete }),
        season('gone', { archive: { ...complete, regions: {}, status: 'unarchivable' } }),
        season('owed'),
      ],
      { now, regions: REGIONS },
    );

    expect(pending.map((item) => item.slug)).toEqual(['owed']);
  });

  it('still owes an incomplete or partial season, unless it is set aside for this tick', () => {
    const incomplete = season('flaky', {
      archive: {
        ...complete,
        status: 'incomplete',
        regions: { us: { ...regionDone, status: 'incomplete', failedPages: [7] } },
      },
    });
    const partial = season('interrupted', {
      archive: { ...complete, status: 'partial', regions: { us: regionDone } },
    });

    expect(pendingSeasons([incomplete, partial], { now, regions: REGIONS })).toHaveLength(2);
    expect(
      pendingSeasons([incomplete], { now, regions: REGIONS, skip: new Set(['flaky']) }),
    ).toHaveLength(0);
  });

  it('never owes the running season', () => {
    const running = season('season-mn-2', { ends: { us: new Date('2030-01-01') } });

    expect(pendingSeasons([running], { now, regions: REGIONS })).toHaveLength(0);
  });
});
