import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import {
  MPLUS_SEASON_STATE_COLLECTION,
  MPLUS_SEASON_TRANSITIONS_COLLECTION,
  MPLUS_SEASONS_COLLECTION,
} from '../src/mplus-season/entities/mplus-season.entity.js';
import { MplusCatalogueService } from '../src/mplus-season/mplus-catalogue.service.js';
import {
  MplusSeasonEvents,
  type MplusSeasonTransitionEvent,
} from '../src/mplus-season/mplus-season-events.service.js';
import { MplusSeasonTransitionScheduler } from '../src/mplus-season/mplus-season-transition.scheduler.js';
import { MplusSeasonTransitionService } from '../src/mplus-season/mplus-season-transition.service.js';
import { MplusSeasonService } from '../src/mplus-season/mplus-season.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectInvariants, expectNoOrphanMplusCharacters } from './support/invariants.js';
import { MplusWorld, type MplusWorldSeason } from './support/mplus-world.js';
import { World } from './support/world.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PLACEHOLDER_END = '2030-01-01T00:00:00Z';

/**
 * A Mythic+ season ending and the next one opening while the process runs —
 * the Mythic+ counterpart of `s6-rollover-runtime.spec.ts` and
 * `s6-season-transition.spec.ts`.
 *
 * One story, told in order, because each step is only meaningful given the one
 * before: the season ends and stays live; the next opens in the US first and
 * the US rolls alone; the archive takes the old season and only then is the
 * US's old board retired; Europe opens the new season and is retired by the
 * rollover event on its own; and a rollover that happens while the process is
 * down is recognised at the next boot.
 *
 * Dates are relative to the real clock, because the season check and the pass
 * both resolve "now" for themselves.
 */
describe('Mythic+ season transitions at runtime', () => {
  const ENV = {
    RAIDERIO_REGIONS: 'us,eu',
    // Both on, so the season check runs and the transition is not warned about
    // an archive that is off. Neither ticks: both wait for a PvP warm-up this
    // file never provides, so every pass and every archive tick is driven here.
    MPLUS_ENABLED: 'true',
    MPLUS_ARCHIVE_ENABLED: 'true',
    MPLUS_SEASON_REFRESH_ENABLED: 'true',
    MPLUS_TRANSITION_ENABLED: 'true',
  };

  const mplusWorld = new MplusWorld();
  const world = World.seed({ regions: ['us'], players: 10 });
  let app: TestApp;
  let db: Db;
  const events: MplusSeasonTransitionEvent[] = [];

  const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  const seasonOf = (slug: string) => mplusWorld.seasons.find((season) => season.slug === slug)!;
  const count = (collection: string, season: string, region: string) =>
    db.collection(collection).countDocuments({ season, region });
  const refreshCatalogue = () => app.app.get(MplusCatalogueService).refresh();
  const observe = () => app.app.get(MplusSeasonService).observe();
  const plan = () => app.app.get(MplusSeasonTransitionService).plan();

  const sweep = async () => {
    const result = await app.app.get(MplusService).sweep();
    expect(result, 'the pass must not be skipped').not.toBeNull();
    // A rollover noticed by the pass ticks the transition, which waits for the
    // pass and then runs; settle it so nothing races the next assertion.
    await app.app.get(MplusSeasonTransitionScheduler).whenSettled();

    return result!;
  };

  const boot = async () => {
    app = await bootTestApp(world, ENV, undefined, undefined, mplusWorld);
    db = app.app.get(MongoService).db;
    app.app.get(MplusSeasonEvents).transitions$.subscribe((event) => events.push(event));
    await app.settle();
  };

  beforeAll(async () => {
    const mn1: MplusWorldSeason = {
      slug: 'season-mn-1',
      name: 'MN Season 1',
      blizzardSeasonId: 17,
      isMainSeason: true,
      starts: { us: at(-200 * DAY), eu: at(-200 * DAY + 13 * HOUR) },
      ends: { us: at(-30 * DAY), eu: at(-30 * DAY + 13 * HOUR) },
      dungeons: 8,
    };
    const mn2: MplusWorldSeason = {
      slug: 'season-mn-2',
      name: 'MN Season 2',
      blizzardSeasonId: 18,
      isMainSeason: true,
      starts: { us: at(-29 * DAY), eu: at(-29 * DAY + 13 * HOUR) },
      ends: { us: PLACEHOLDER_END, eu: PLACEHOLDER_END },
      dungeons: 8,
    };
    mplusWorld.seasons = [mn2, mn1];
    mplusWorld.seed('us', 30, 500).seed('eu', 30, 480);

    await boot();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await app?.close();
  });

  it('reads the season catalogue at boot, before anything asks for runs', async () => {
    expect(await db.collection(MPLUS_SEASONS_COLLECTION).countDocuments()).toBe(2);
    expect(app.raiderIo.countMatching('mythic-plus/static-data')).toBeGreaterThan(0);
    expect(app.raiderIo.countMatching('mythic-plus/runs'), 'no pass has run').toBe(0);

    const state = await db.collection(MPLUS_SEASON_STATE_COLLECTION).find({}).toArray();
    expect(Object.fromEntries(state.map((entry) => [entry.region, entry.season]))).toEqual({
      us: 'season-mn-2',
      eu: 'season-mn-2',
    });
  });

  it('reads the catalogue itself, first, when a pass finds none', async () => {
    await db.collection(MPLUS_SEASONS_COLLECTION).deleteMany({});
    app.raiderIo.reset();

    const result = await sweep();

    const paths = app.raiderIo.requests.map((request) => request.path);
    const lastCatalogue = paths.lastIndexOf('mythic-plus/static-data');
    const firstRuns = paths.indexOf('mythic-plus/runs');

    expect(lastCatalogue, 'the catalogue was read').toBeGreaterThanOrEqual(0);
    expect(firstRuns, 'every catalogue request came before the first runs request').toBeGreaterThan(
      lastCatalogue,
    );
    expect(result.seasons).toEqual({ us: 'season-mn-2', eu: 'season-mn-2' });
  });

  describe('the season ends in one region', () => {
    beforeAll(async () => {
      // Raider.io replaces the 2030 placeholder with the real end.
      seasonOf('season-mn-2').ends = { us: at(-HOUR), eu: PLACEHOLDER_END };
      await refreshCatalogue();
      await observe();
    });

    it('announces the end in that region only', () => {
      expect(events.map((event) => [event.kind, event.region, event.season])).toEqual([
        ['ended', 'us', 'season-mn-2'],
      ]);
    });

    it('stays the live season, and the pass keeps ingesting it without churn', async () => {
      const before = await count(MPLUS_RUNS_COLLECTION, 'season-mn-2', 'us');

      const result = await sweep();

      // An end date is metadata. The board does not empty, and nothing prunes.
      expect(result.seasons).toEqual({ us: 'season-mn-2', eu: 'season-mn-2' });
      expect(result.regions.every((region) => region.prunedRuns === 0)).toBe(true);
      expect(await count(MPLUS_RUNS_COLLECTION, 'season-mn-2', 'us')).toBe(before);
    });

    it('is not archived while another region is still playing it', async () => {
      const tick = await app.app.get(MplusArchiveService).archiveBacklog();

      expect(tick!.seasons.map((season) => season.season)).not.toContain('season-mn-2');
    });

    it('retires nothing: no region has a new season to replace it with', async () => {
      const current = await plan();

      expect(current.permitted).toBe(true);
      expect(current.candidates).toEqual([]);
      expect(current.blockedByArchive).toEqual([]);
    });
  });

  describe('the next season opens in the US first', () => {
    beforeAll(async () => {
      events.length = 0;
      mplusWorld.seasons.unshift({
        slug: 'season-mn-3',
        name: 'MN Season 3',
        blizzardSeasonId: 19,
        isMainSeason: true,
        starts: { us: at(-10 * 60_000), eu: at(DAY) },
        ends: { us: PLACEHOLDER_END, eu: PLACEHOLDER_END },
        dungeons: 8,
      });
      await refreshCatalogue();
    });

    it('rolls the US over and leaves Europe on the old season', async () => {
      const result = await sweep();

      expect(result.seasons).toEqual({ us: 'season-mn-3', eu: 'season-mn-2' });
      expect(events.map((event) => [event.kind, event.region, event.season])).toEqual([
        ['rollover', 'us', 'season-mn-3'],
      ]);
      expect(await count(MPLUS_RUNS_COLLECTION, 'season-mn-3', 'us')).toBeGreaterThan(0);
    });

    it("holds the US's old board until the archive has it, even after the rollover tick", async () => {
      // The rollover ticked the transition, which ran after the pass: nothing
      // could be retired, because Europe is still playing season 2 and so the
      // archive cannot have it.
      expect(await count(MPLUS_RUNS_COLLECTION, 'season-mn-2', 'us')).toBeGreaterThan(0);

      const current = await plan();
      expect(current.current).toEqual({ us: 'season-mn-3', eu: 'season-mn-2' });
      expect(current.candidates).toEqual([]);
      expect(current.blockedByArchive).toEqual([
        { region: 'us', season: 'season-mn-2', archived: false, archiveStatus: null },
      ]);
    });
  });

  describe('the old season ends everywhere and is archived', () => {
    beforeAll(async () => {
      seasonOf('season-mn-2').ends = { us: at(-2 * HOUR), eu: at(-60_000) };
      await refreshCatalogue();
      await observe();

      const tick = await app.app.get(MplusArchiveService).archiveBacklog();
      expect(tick!.seasons.find((season) => season.season === 'season-mn-2')?.outcome).toBe(
        'complete',
      );
    });

    it('retires the old season in the US, where the new one has opened', async () => {
      const { purged } = await app.app.get(MplusSeasonTransitionService).run();

      expect(purged.map((entry) => [entry.season, entry.region])).toEqual([['season-mn-2', 'us']]);
      expect(await count(MPLUS_RUNS_COLLECTION, 'season-mn-2', 'us')).toBe(0);
      expect(await count(MPLUS_CHARACTERS_COLLECTION, 'season-mn-2', 'us')).toBe(0);

      const record = await db
        .collection(MPLUS_SEASON_TRANSITIONS_COLLECTION)
        .findOne({ season: 'season-mn-2', region: 'us' });
      expect(record?.triggeredBy).toBe('season-mn-3');
      expect(record?.dryRun).toBe(false);
    });

    it('keeps it in Europe, where it is ended but still the live board', async () => {
      expect(await count(MPLUS_RUNS_COLLECTION, 'season-mn-2', 'eu')).toBeGreaterThan(0);
      expect(await count(MPLUS_RUNS_COLLECTION, 'season-mn-3', 'us')).toBeGreaterThan(0);

      await expectInvariants(db);
      await expectNoOrphanMplusCharacters(db);
    });
  });

  describe('Europe opens the new season', () => {
    it('is retired there by the rollover event, with no one calling the transition', async () => {
      events.length = 0;
      seasonOf('season-mn-3').starts = { us: at(-2 * HOUR), eu: at(-60_000) };
      await refreshCatalogue();

      await observe();
      await app.app.get(MplusSeasonTransitionScheduler).whenSettled();

      expect(events.map((event) => [event.kind, event.region])).toEqual([['rollover', 'eu']]);
      expect(await count(MPLUS_RUNS_COLLECTION, 'season-mn-2', 'eu')).toBe(0);
      expect(await count(MPLUS_CHARACTERS_COLLECTION, 'season-mn-2', 'eu')).toBe(0);
      expect(await db.collection(MPLUS_RUNS_COLLECTION).distinct('season')).toEqual([
        'season-mn-3',
      ]);
    });
  });

  describe('a season that rolls while the process is down', () => {
    it('is recognised as a rollover at the next boot', async () => {
      // Past the catalogue TTL, as a real outage of a day or more would be.
      await db
        .collection(MPLUS_SEASONS_COLLECTION)
        .updateMany({}, { $set: { catalogueUpdatedAt: new Date(Date.now() - 2 * DAY) } });

      await app.close();
      events.length = 0;

      mplusWorld.seasons.unshift({
        slug: 'season-mn-4',
        name: 'MN Season 4',
        blizzardSeasonId: 20,
        isMainSeason: true,
        starts: { us: at(-60_000), eu: at(-60_000) },
        ends: { us: PLACEHOLDER_END, eu: PLACEHOLDER_END },
        dungeons: 8,
      });
      await boot();

      const state = await db.collection(MPLUS_SEASON_STATE_COLLECTION).find({}).toArray();
      expect(Object.fromEntries(state.map((entry) => [entry.region, entry.season]))).toEqual({
        us: 'season-mn-4',
        eu: 'season-mn-4',
      });

      // A rollover rather than a first sighting, because what was last observed
      // was persisted and rehydrated before the boot-time check compared.
      expect(events).toEqual([
        expect.objectContaining({ kind: 'rollover', region: 'us', acrossRestart: true }),
        expect.objectContaining({ kind: 'rollover', region: 'eu', acrossRestart: true }),
      ]);

      // And the transition plans season 3's retirement, held only by the archive.
      // The US only: no pass ran in Europe while it was on season 3, so there
      // is nothing of it stored there to retire.
      const current = await plan();
      expect(current.current).toEqual({ us: 'season-mn-4', eu: 'season-mn-4' });
      expect(current.blockedByArchive.map((entry) => [entry.season, entry.region])).toEqual([
        ['season-mn-3', 'us'],
      ]);
    });
  });
});
