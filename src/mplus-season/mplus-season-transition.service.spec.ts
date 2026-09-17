import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import type { MongoService } from '../database/mongo.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../mplus/entities/mplus-run.entity.js';
import type { MplusSeasonDocument } from './entities/mplus-season.entity.js';
import type { MplusCatalogueRepository } from './mplus-catalogue.repository.js';
import type { MplusSeasonStateRepository } from './mplus-season-state.repository.js';
import {
  MplusSeasonTransitionService,
  supersededSeasons,
} from './mplus-season-transition.service.js';

const now = new Date('2026-09-14T00:00:00Z');

function season(slug: string, overrides: Partial<MplusSeasonDocument> = {}): MplusSeasonDocument {
  return {
    slug,
    name: slug,
    shortName: null,
    expansionId: 11,
    blizzardSeasonId: 18,
    starts: {},
    ends: {},
    dungeonIds: [],
    catalogueUpdatedAt: now,
    ...overrides,
  };
}

const archived = {
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

const mn1 = season('season-mn-1', {
  starts: { us: new Date('2026-03-24T15:00:00Z') },
  ends: { us: new Date('2026-08-18T15:00:00Z') },
});
const mn2 = season('season-mn-2', {
  starts: { us: new Date('2026-08-18T15:00:00Z'), eu: new Date('2026-09-20T04:00:00Z') },
});

describe('supersededSeasons', () => {
  const catalogue = new Map([mn1, mn2].map((entry) => [entry.slug, entry]));
  const current = { slug: 'season-mn-2', startsAt: new Date('2026-08-18T15:00:00Z') };

  it('is every stored season that opened before the current one', () => {
    expect(supersededSeasons(['season-mn-1', 'season-mn-2'], current, catalogue, 'us')).toEqual([
      'season-mn-1',
    ]);
  });

  it('includes a slug the catalogue does not list: the pass never writes one', () => {
    expect(supersededSeasons(['season-mn-1-break-the-meta'], current, catalogue, 'us')).toEqual([
      'season-mn-1-break-the-meta',
    ]);
  });

  it('never includes a stored season that opened after the current one', () => {
    const later = season('season-mn-3', { starts: { us: new Date('2027-01-19T15:00:00Z') } });
    const withLater = new Map([...catalogue, [later.slug, later]]);

    expect(supersededSeasons(['season-mn-3'], current, withLater, 'us')).toEqual([]);
  });
});

function serviceOver(options: {
  seasons: MplusSeasonDocument[];
  stored: Record<string, Record<string, string[]>>;
  requireArchive?: boolean;
  dryRun?: boolean;
  mplusActive?: boolean;
}) {
  const deleteMany = vi.fn<(filter: unknown) => Promise<{ deletedCount: number }>>(async () => ({
    deletedCount: 3,
  }));
  const countDocuments = vi.fn(async () => 7);
  const deletions: string[] = [];
  const mongo = {
    collection: (name: string) => ({
      distinct: async (_field: string, filter: { region: string }) =>
        options.stored[name]?.[filter.region] ?? [],
      deleteMany: async (filter: unknown) => {
        deletions.push(name);
        return deleteMany(filter);
      },
      countDocuments,
    }),
  } as unknown as MongoService;
  const catalogue = {
    allSeasons: async () => options.seasons,
  } as unknown as MplusCatalogueRepository;
  const recordPurge = vi.fn(async () => undefined);
  const state = { recordPurge } as unknown as MplusSeasonStateRepository;
  const coordinator = {
    isMplusActive: options.mplusActive ?? false,
  } as unknown as IngestionCoordinator;
  const env: Record<string, unknown> = {
    RAIDERIO_REGIONS: ['us', 'eu'],
    MPLUS_PURGE_REQUIRE_ARCHIVE: options.requireArchive ?? true,
    MPLUS_PURGE_DRY_RUN: options.dryRun ?? false,
  };
  const config = { get: (key: string) => env[key] } as unknown as ConfigService<never, true>;

  return {
    service: new MplusSeasonTransitionService(config, mongo, catalogue, state, coordinator),
    deleteMany,
    countDocuments,
    deletions,
    recordPurge,
  };
}

const bothRegionsStored = {
  [MPLUS_RUNS_COLLECTION]: {
    us: ['season-mn-1', 'season-mn-2'],
    eu: ['season-mn-1'],
  },
  [MPLUS_CHARACTERS_COLLECTION]: {
    us: ['season-mn-1', 'season-mn-2'],
    eu: ['season-mn-1'],
  },
};

describe('MplusSeasonTransitionService.plan', () => {
  it('retires a season only in regions that have opened its successor', async () => {
    const { service } = serviceOver({
      seasons: [{ ...mn1, archive: archived }, mn2],
      stored: bothRegionsStored,
    });

    const plan = await service.plan(now);

    // Europe opens season 2 on the 20th, so season 1 is still its live board.
    expect(plan.current).toEqual({ us: 'season-mn-2', eu: 'season-mn-1' });
    expect(plan.candidates).toEqual([
      { region: 'us', season: 'season-mn-1', archived: true, archiveStatus: 'complete' },
    ]);
  });

  it('holds back a season the archive does not hold yet', async () => {
    const { service } = serviceOver({ seasons: [mn1, mn2], stored: bothRegionsStored });

    const plan = await service.plan(now);

    expect(plan.candidates).toEqual([]);
    expect(plan.blockedByArchive).toEqual([
      { region: 'us', season: 'season-mn-1', archived: false, archiveStatus: null },
    ]);
  });

  it('treats a season Raider.io refuses to serve as settled', async () => {
    const { service } = serviceOver({
      seasons: [{ ...mn1, archive: { ...archived, status: 'unarchivable' } }, mn2],
      stored: bothRegionsStored,
    });

    expect((await service.plan(now)).candidates).toHaveLength(1);
  });

  it('holds back a season whose archive has a page outstanding', async () => {
    const { service } = serviceOver({
      seasons: [{ ...mn1, archive: { ...archived, status: 'incomplete', failedPages: [4] } }, mn2],
      stored: bothRegionsStored,
    });

    expect((await service.plan(now)).blockedByArchive).toHaveLength(1);
  });

  it('retires without an archive when the interlock is off', async () => {
    const { service } = serviceOver({
      seasons: [mn1, mn2],
      stored: bothRegionsStored,
      requireArchive: false,
    });

    const plan = await service.plan(now);

    expect(plan.candidates).toEqual([
      { region: 'us', season: 'season-mn-1', archived: false, archiveStatus: null },
    ]);
  });

  it('abstains while a pass is running, since the pass may still be writing the old season', async () => {
    const { service } = serviceOver({
      seasons: [{ ...mn1, archive: archived }, mn2],
      stored: bothRegionsStored,
      mplusActive: true,
    });

    const plan = await service.plan(now);

    expect(plan.permitted).toBe(false);
    expect(plan.reason).toBe('a Mythic+ pass is running');
  });

  it('abstains with no catalogue, where every stored season would look like a leftover', async () => {
    const { service } = serviceOver({ seasons: [], stored: bothRegionsStored });

    expect((await service.plan(now)).permitted).toBe(false);
  });
});

describe('MplusSeasonTransitionService.run', () => {
  it('deletes characters before runs, and records the purge', async () => {
    const { service, deletions, recordPurge } = serviceOver({
      seasons: [{ ...mn1, archive: archived }, mn2],
      stored: bothRegionsStored,
    });

    const { purged } = await service.run(now);

    // Characters first, so every character is named by a run at every moment.
    expect(deletions).toEqual([MPLUS_CHARACTERS_COLLECTION, MPLUS_RUNS_COLLECTION]);
    expect(purged).toEqual([
      {
        region: 'us',
        season: 'season-mn-1',
        removed: { [MPLUS_CHARACTERS_COLLECTION]: 3, [MPLUS_RUNS_COLLECTION]: 3 },
        dryRun: false,
      },
    ]);
    expect(recordPurge).toHaveBeenCalledWith(
      expect.objectContaining({ season: 'season-mn-1', region: 'us', triggeredBy: 'season-mn-2' }),
    );
  });

  it('counts and deletes nothing on a dry run', async () => {
    const { service, deleteMany, countDocuments } = serviceOver({
      seasons: [{ ...mn1, archive: archived }, mn2],
      stored: bothRegionsStored,
      dryRun: true,
    });

    const { purged } = await service.run(now);

    expect(deleteMany).not.toHaveBeenCalled();
    expect(countDocuments).toHaveBeenCalledTimes(2);
    expect(purged[0].dryRun).toBe(true);
  });
});
