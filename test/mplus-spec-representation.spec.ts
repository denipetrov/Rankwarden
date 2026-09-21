import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import {
  MPLUS_SPEC_REPRESENTATION_COLLECTION,
  type MplusSpecRepresentationDocument,
} from '../src/mplus-representation/entities/mplus-spec-representation.entity.js';
import { MPLUS_SEASONS_COLLECTION } from '../src/mplus-season/entities/mplus-season.entity.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/**
 * Mythic+ spec representation: live for the current season, recomputed after
 * every pass; written once for a season the archive completes, and left alone
 * after that.
 *
 * The world's runs serve every season, so the live board (`season-mn-2`) and
 * the archived one (`season-mn-1`) count the same rosters. Each run is a tank,
 * a healer and three damage dealers, one of whom is anonymised every 40th run.
 */
describe('Mythic+ spec representation', () => {
  let app: TestApp;
  let db: Db;
  const world = new MplusWorld();

  const documents = () =>
    db
      .collection<MplusSpecRepresentationDocument>(MPLUS_SPEC_REPRESENTATION_COLLECTION)
      .find({}, { projection: { _id: 0 } })
      .sort({ season: 1, region: 1 })
      .toArray();
  const documentFor = async (season: string, region: string) =>
    (await documents()).find(
      (document) => document.season === season && document.region === region,
    );

  beforeAll(async () => {
    world.seed('us', 30, 500).seed('eu', 20, 480);

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 10 }),
      { RAIDERIO_REGIONS: 'us,eu' },
      undefined,
      undefined,
      world,
    );
    db = app.app.get(MongoService).db;
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await app?.close();
  });

  describe('the current season', () => {
    beforeAll(async () => {
      await app.app.get(MplusService).sweep();
    });

    it('is recorded per region and for all regions, from the live board', async () => {
      const live = (await documents()).filter((document) => document.season === 'season-mn-2');

      expect(live.map((document) => [document.region, document.source, document.runs])).toEqual([
        ['all', 'live', 50],
        ['eu', 'live', 20],
        ['us', 'live', 30],
      ]);
    });

    it('counts every roster slot of every run', async () => {
      const us = (await documentFor('season-mn-2', 'us'))!;

      expect(us.slots, 'five a run').toBe(150);
      expect(us.classified).toBe(150);
      expect(us.roles).toEqual({ tank: 30, healer: 30, dps: 90 });

      const all = (await documentFor('season-mn-2', 'all'))!;
      expect(all.slots).toBe(250);
    });

    it('shares add up, overall and within each role', async () => {
      const us = (await documentFor('season-mn-2', 'us'))!;
      const total = us.specs.reduce((sum, spec) => sum + spec.percent, 0);

      expect(total).toBeCloseTo(100, 1);
      for (const role of ['tank', 'healer', 'dps']) {
        const within = us.specs
          .filter((spec) => spec.role === role)
          .reduce((sum, spec) => sum + spec.rolePercent, 0);
        expect(within, role).toBeCloseTo(100, 1);
      }

      // The one tank spec in the world is a fifth of all slots and all of its role.
      const tank = us.specs.find((spec) => spec.role === 'tank')!;
      expect(tank).toMatchObject({ specId: 250, count: 30, percent: 20, rolePercent: 100 });
    });

    it('moves with the board: the next pass recomputes it', async () => {
      const before = (await documentFor('season-mn-2', 'us'))!;

      world.seed('us', 10, 499);
      await app.app.get(MplusService).sweep();

      const after = (await documentFor('season-mn-2', 'us'))!;
      expect(after.runs).toBe(40);
      expect(after.computedAt.getTime()).toBeGreaterThan(before.computedAt.getTime());
    });
  });

  describe('an archived season', () => {
    beforeAll(async () => {
      await app.app.get(MplusArchiveService).archiveBacklog();
    });

    it('is recorded once the archive holds it in every region, from the archive', async () => {
      const archived = (await documents()).filter((document) => document.season === 'season-mn-1');

      // MPLUS_ARCHIVE_PAGES is 3 in the harness: 60 runs a region at most.
      expect(archived.map((document) => [document.region, document.source, document.runs])).toEqual(
        [
          ['all', 'archive', 60],
          ['eu', 'archive', 20],
          ['us', 'archive', 40],
        ],
      );
    });

    it('is never recomputed: a later tick leaves it exactly as it was', async () => {
      const before = await documentFor('season-mn-1', 'all');

      await app.app.get(MplusArchiveService).archiveBacklog();

      expect(await documentFor('season-mn-1', 'all')).toEqual(before);
    });

    it('is recorded by the next tick if its figures went missing', async () => {
      await db
        .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
        .deleteMany({ season: 'season-mn-1' });

      await app.app.get(MplusArchiveService).archiveBacklog();

      expect((await documentFor('season-mn-1', 'all'))?.source).toBe('archive');
    });

    it('is left alone by the live pass once archived, though the pass still reads it', async () => {
      // A season stays current in a region until its successor opens, so a pass
      // can still be reading one the archive has completed. Stand that in by
      // marking the current season archived everywhere.
      const us = await documentFor('season-mn-2', 'us');
      const region = {
        status: 'complete',
        pagesFetched: 3,
        failedPages: [],
        runs: 1,
        characters: 1,
        archivedAt: new Date(),
        source: 'fetched',
      };
      await db.collection(MPLUS_SEASONS_COLLECTION).updateOne(
        { slug: 'season-mn-2' },
        {
          $set: {
            archive: {
              status: 'complete',
              pagesPlanned: 3,
              pagesFetched: 6,
              failedPages: [],
              runs: 2,
              characters: 2,
              regions: { us: region, eu: region },
              archivedAt: new Date(),
              source: 'fetched',
            },
          },
        },
      );

      world.seed('us', 5, 498);
      await app.app.get(MplusService).sweep();

      expect(await documentFor('season-mn-2', 'us'), 'not overwritten by the live board').toEqual(
        us,
      );
    });
  });
});
