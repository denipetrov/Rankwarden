import { describe, expect, it } from 'vitest';

import type { MplusSeasonDocument } from '../mplus-season/entities/mplus-season.entity.js';
import { isFinished, pendingSeasons } from './mplus-archive.mapper.js';

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
