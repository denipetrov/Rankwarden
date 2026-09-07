import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MongoService } from '../database/mongo.service.js';
import { SeasonStateRepository } from './season-state.repository.js';
import { SeasonTransitionService } from './season-transition.service.js';
import type { SeasonStateDocument } from './entities/season-state.entity.js';

const env: Record<string, unknown> = {
  BLIZZARD_REGIONS: ['us', 'eu'],
  SEASON_PURGE_REQUIRE_ARCHIVE: true,
  SEASON_PURGE_DRY_RUN: false,
};

function state(region: string, seasonId: number, startsAt: string): SeasonStateDocument {
  return {
    region: region as SeasonStateDocument['region'],
    seasonId,
    startsAt: new Date(startsAt),
    endsAt: null,
    lastCompletedSeasonId: seasonId - 1,
    observedAt: new Date(startsAt),
  };
}

describe('SeasonTransitionService', () => {
  const loadAll = vi.fn();
  const purgedPairs = vi.fn();
  const recordPurge = vi.fn();
  /** Seasons per region present in `characters`. */
  let storedSeasons: Record<string, number[]>;
  /** Season/region pairs the archive holds in full. */
  let archived: { seasonId: number; region: string }[];
  let deleted: { name: string; filter: unknown }[];
  let counts: Record<string, number>;

  const collection = (name: string) => ({
    distinct: async (_field: string, filter: { region: string }) =>
      storedSeasons[filter.region] ?? [],
    find: () => ({ toArray: async () => archived }),
    countDocuments: async () => counts[name] ?? 0,
    deleteMany: async (filter: unknown) => {
      deleted.push({ name, filter });
      return { deletedCount: counts[name] ?? 0 };
    },
  });

  async function build(overrides: Record<string, unknown> = {}) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        SeasonTransitionService,
        { provide: MongoService, useValue: { collection } },
        { provide: SeasonStateRepository, useValue: { loadAll, purgedPairs, recordPurge } },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => ({ ...env, ...overrides })[key] },
        },
      ],
    }).compile();

    return moduleRef.get(SeasonTransitionService);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    storedSeasons = {};
    archived = [];
    deleted = [];
    counts = {};
    purgedPairs.mockResolvedValue(new Set<string>());
    recordPurge.mockResolvedValue(undefined);
  });

  it('abstains while a configured region has never been observed', async () => {
    // One region failing at boot must never look like a rollover.
    loadAll.mockResolvedValue([state('us', 43, '2026-08-18T15:00:00.000Z')]);
    const service = await build();

    const plan = await service.plan(new Date('2026-08-19T00:00:00.000Z'));

    expect(plan.permitted).toBe(false);
    expect(plan.reason).toContain('eu not yet observed');
    expect(plan.candidates).toEqual([]);
  });

  it('abstains before the new season has actually begun', async () => {
    // A finished season stays live and readable until the next one starts.
    loadAll.mockResolvedValue([
      state('us', 43, '2026-09-01T15:00:00.000Z'),
      state('eu', 42, '2026-05-01T15:00:00.000Z'),
    ]);
    const service = await build();

    const plan = await service.plan(new Date('2026-08-20T00:00:00.000Z'));

    expect(plan.permitted).toBe(false);
    expect(plan.transitionAt).toBe('2026-09-01T15:00:00.000Z');
  });

  it('opens the gate on the earliest start among regions on the newest season', async () => {
    loadAll.mockResolvedValue([
      state('us', 43, '2026-09-01T15:00:00.000Z'),
      state('eu', 43, '2026-09-02T23:00:00.000Z'),
    ]);
    const service = await build();

    const plan = await service.plan(new Date('2026-09-01T16:00:00.000Z'));

    expect(plan.permitted).toBe(true);
    expect(plan.newestSeason).toBe(43);
    expect(plan.transitionAt).toBe('2026-09-01T15:00:00.000Z');
  });

  it('leaves a trailing region its own live season alone', async () => {
    // Regions stagger by up to 32 hours. Deleting every region at the earliest
    // start would empty a board a region is still playing, its next sweep would
    // rewrite it, and the next tick would remove it again.
    loadAll.mockResolvedValue([
      state('us', 43, '2026-09-01T15:00:00.000Z'),
      state('eu', 42, '2026-05-01T15:00:00.000Z'),
    ]);
    storedSeasons = { us: [42, 43], eu: [42] };
    archived = [
      { seasonId: 42, region: 'us' },
      { seasonId: 42, region: 'eu' },
    ];
    const service = await build();

    const plan = await service.plan(new Date('2026-09-01T16:00:00.000Z'));

    expect(plan.candidates).toEqual([{ region: 'us', seasonId: 42, archived: true }]);
  });

  it('holds back a season the archive does not hold in full', async () => {
    // After a purge the archive is the only surviving copy.
    loadAll.mockResolvedValue([
      state('us', 43, '2026-09-01T15:00:00.000Z'),
      state('eu', 43, '2026-09-01T15:00:00.000Z'),
    ]);
    storedSeasons = { us: [41, 42, 43], eu: [] };
    archived = [{ seasonId: 42, region: 'us' }];
    const service = await build();

    const plan = await service.plan(new Date('2026-09-02T00:00:00.000Z'));

    expect(plan.candidates).toEqual([{ region: 'us', seasonId: 42, archived: true }]);
    expect(plan.blockedByArchive).toEqual([{ region: 'us', seasonId: 41, archived: false }]);
  });

  it('purges without the archive interlock when it is switched off', async () => {
    loadAll.mockResolvedValue([
      state('us', 43, '2026-09-01T15:00:00.000Z'),
      state('eu', 43, '2026-09-01T15:00:00.000Z'),
    ]);
    storedSeasons = { us: [42, 43], eu: [] };
    const service = await build({ SEASON_PURGE_REQUIRE_ARCHIVE: false });

    const plan = await service.plan(new Date('2026-09-02T00:00:00.000Z'));

    expect(plan.candidates).toEqual([{ region: 'us', seasonId: 42, archived: true }]);
  });

  it('never offers a season it has already purged', async () => {
    loadAll.mockResolvedValue([
      state('us', 43, '2026-09-01T15:00:00.000Z'),
      state('eu', 43, '2026-09-01T15:00:00.000Z'),
    ]);
    storedSeasons = { us: [42, 43], eu: [] };
    archived = [{ seasonId: 42, region: 'us' }];
    purgedPairs.mockResolvedValue(new Set(['42:us']));
    const service = await build();

    const plan = await service.plan(new Date('2026-09-02T00:00:00.000Z'));

    expect(plan.candidates).toEqual([]);
    expect(plan.reason).toBe('nothing to retire');
  });

  it('deletes rating rows before the characters they point at', async () => {
    counts = { characters: 10, '3v3_ratings': 5, spec_representation: 2 };
    const service = await build();

    await service.purge({ region: 'us', seasonId: 42, archived: true }, 43);

    const order = deleted.map((entry) => entry.name);
    // Reversing these leaves a window in which a crash produces exactly the
    // orphan rows the sweep cleanup exists to remove.
    expect(order.indexOf('characters')).toBeGreaterThan(order.indexOf('3v3_ratings'));
    expect(order.indexOf('spec_representation')).toBeGreaterThan(order.indexOf('characters'));
    expect(order).toContain('shuffle_ratings');
  });

  it('scopes every delete to one season and one region', async () => {
    const service = await build();

    await service.purge({ region: 'us', seasonId: 42, archived: true }, 43);

    for (const entry of deleted) {
      expect(entry.filter).toEqual({ seasonId: 42, region: 'us' });
    }
  });

  it('records the purge so it can never run twice', async () => {
    counts = { characters: 10 };
    const service = await build();

    await service.purge({ region: 'us', seasonId: 42, archived: true }, 43);

    expect(recordPurge).toHaveBeenCalledWith(
      expect.objectContaining({
        seasonId: 42,
        region: 'us',
        triggeredBy: 43,
        dryRun: false,
        removed: expect.objectContaining({ characters: 10 }),
      }),
    );
  });

  it('deletes nothing in dry run, but still reports what it would remove', async () => {
    counts = { characters: 10, '3v3_ratings': 5 };
    const service = await build({ SEASON_PURGE_DRY_RUN: true });

    const outcome = await service.purge({ region: 'us', seasonId: 42, archived: true }, 43);

    expect(deleted).toEqual([]);
    expect(outcome.dryRun).toBe(true);
    expect(outcome.removed.characters).toBe(10);
    expect(recordPurge).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }));
  });

  it('does not purge while the gate is shut', async () => {
    loadAll.mockResolvedValue([state('us', 43, '2026-09-01T15:00:00.000Z')]);
    const service = await build();

    const { purged } = await service.run(new Date('2026-09-02T00:00:00.000Z'));

    expect(purged).toEqual([]);
    expect(deleted).toEqual([]);
  });
});
