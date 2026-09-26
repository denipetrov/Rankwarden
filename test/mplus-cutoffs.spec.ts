import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import type { MplusSeasonCutoffs } from '../src/mplus-season/entities/mplus-cutoffs.entity.js';
import {
  MPLUS_SEASONS_COLLECTION,
  type MplusSeasonDocument,
} from '../src/mplus-season/entities/mplus-season.entity.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/**
 * Title and percentile cutoffs on the season catalogue: read per region, every
 * pass while a season is live, once when it is archived.
 *
 * The world serves `season-mn-2` live and `season-mn-1` finished. The cases at
 * the end take the cutoffs away from a season, standing in for the two shapes
 * upstream really has: a 404 for every season before `season-sl-3`, and a
 * repeated 500 for `cn` before `season-df-4`.
 */
describe('Mythic+ season cutoffs', () => {
  let app: TestApp;
  let db: Db;
  const world = new MplusWorld();

  const cutoffsFor = async (season: string, region: string) => {
    const document = await db
      .collection<MplusSeasonDocument>(MPLUS_SEASONS_COLLECTION)
      .findOne({ slug: season });

    return document?.cutoffs?.[region as 'us'] as MplusSeasonCutoffs | undefined;
  };
  const requests = (season?: string) =>
    app.raiderIo.requests.filter(
      (request) =>
        request.path === 'mythic-plus/season-cutoffs' &&
        (season === undefined || request.season === season),
    );

  beforeAll(async () => {
    world.cutoffBase['season-mn-2'] = 3_800;
    world.cutoffBase['season-mn-1'] = 4_200;
    world.seed('us', 20, 500).seed('eu', 20, 480);

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

  describe('the live season', () => {
    beforeAll(async () => {
      await app.app.get(MplusService).sweep();
    });

    it('is read once per region, and stored on the season', async () => {
      expect(
        requests('season-mn-2')
          .map((request) => request.region)
          .sort(),
      ).toEqual(['eu', 'us']);

      const us = await cutoffsFor('season-mn-2', 'us');
      expect(us?.status).toBe('ok');
      expect(us?.updatedAt).toEqual(new Date('2026-01-19T22:41:01Z'));
    });

    it('carries each title tier, with both factions and both together', async () => {
      const us = (await cutoffsFor('season-mn-2', 'us'))!;

      expect(Object.keys(us.keystones)).toEqual([
        'keystoneExplorer',
        'keystoneConqueror',
        'keystoneMaster',
        'keystoneHero',
      ]);
      expect(us.keystones.keystoneMaster?.score).toBe(2000);
      expect(us.keystones.keystoneMaster?.all?.minScore).toBe(2000);
      expect(us.keystones.keystoneMaster?.horde?.minScore).toBe(1980);
      expect(us.keystones.keystoneMaster?.alliance?.minScore).toBe(2020);

      // The season awarded no Legend or Myth title: left out, not stored null.
      expect(us.keystones).not.toHaveProperty('keystoneLegend');
      expect(us.keystones).not.toHaveProperty('keystoneMyth');
    });

    it('carries the top 0.1% and 1% cutoffs, per region', async () => {
      const us = (await cutoffsFor('season-mn-2', 'us'))!;
      const eu = (await cutoffsFor('season-mn-2', 'eu'))!;

      expect(us.quantiles.p999?.all?.minScore).toBe(3800);
      expect(us.quantiles.p990?.all?.minScore).toBe(3500);
      expect(us.quantiles.p999?.all?.quantile).toBe(0.999);
      // Each region is its own ladder, so each has its own cutoff.
      expect(eu.quantiles.p999?.all?.minScore).toBe(3810);
    });

    it('is read again on the next pass, because a live cutoff moves', async () => {
      const before = (await cutoffsFor('season-mn-2', 'us'))!;
      world.cutoffBase['season-mn-2'] = 3_900;
      app.raiderIo.reset();

      await app.app.get(MplusService).sweep();

      const after = (await cutoffsFor('season-mn-2', 'us'))!;
      expect(requests('season-mn-2')).toHaveLength(2);
      expect(after.quantiles.p999?.all?.minScore).toBe(3900);
      expect(after.fetchedAt.getTime()).toBeGreaterThan(before.fetchedAt.getTime());
    });
  });

  describe('a finished season', () => {
    beforeAll(async () => {
      app.raiderIo.reset();
      await app.app.get(MplusArchiveService).archiveBacklog();
    });

    it('is read once per region as it is archived', async () => {
      expect(
        requests('season-mn-1')
          .map((request) => request.region)
          .sort(),
      ).toEqual(['eu', 'us']);

      const us = (await cutoffsFor('season-mn-1', 'us'))!;
      expect(us.status).toBe('ok');
      expect(us.quantiles.p999?.all?.minScore).toBe(4200);
      expect(us.keystones.keystoneHero?.all?.minScore).toBe(2500);
    });

    it('is never read again: its ladder is closed', async () => {
      const before = (await cutoffsFor('season-mn-1', 'us'))!;
      app.raiderIo.reset();

      await app.app.get(MplusArchiveService).archiveBacklog();
      await app.app.get(MplusService).sweep();

      expect(requests('season-mn-1')).toEqual([]);
      expect((await cutoffsFor('season-mn-1', 'us'))!.fetchedAt).toEqual(before.fetchedAt);
    });

    it('is read by a later tick when a region was left outstanding', async () => {
      // A crash between archiving and reading the cutoffs, or a region that
      // failed: the backfill picks it up.
      await db
        .collection(MPLUS_SEASONS_COLLECTION)
        .updateOne({ slug: 'season-mn-1' }, { $unset: { 'cutoffs.eu': '' } });
      app.raiderIo.reset();

      await app.app.get(MplusArchiveService).archiveBacklog();

      expect(requests('season-mn-1').map((request) => request.region)).toEqual(['eu']);
      expect((await cutoffsFor('season-mn-1', 'eu'))?.status).toBe('ok');
    });
  });

  describe('a season Raider.io has no cutoffs for', () => {
    beforeAll(async () => {
      world.seasonsWithoutCutoffs.add('season-mn-2');
      await db
        .collection(MPLUS_SEASONS_COLLECTION)
        .updateOne({ slug: 'season-mn-2' }, { $unset: { cutoffs: '' } });
      app.raiderIo.reset();

      await app.app.get(MplusService).sweep();
    });

    afterAll(() => {
      world.seasonsWithoutCutoffs.delete('season-mn-2');
    });

    it('is recorded as missing rather than left absent', async () => {
      const us = (await cutoffsFor('season-mn-2', 'us'))!;

      expect(us.status).toBe('missing');
      expect(us.keystones).toEqual({});
      expect(us.lastError, "Raider.io's own words, kept for a reader").toContain(
        'Could not find cutoffs',
      );
    });

    it('is asked again on the next pass while the season is live', async () => {
      // A live season's "none" is not final: Raider.io computes cutoffs some
      // days into a season, and a 404 then says nothing about the figures the
      // season will end with.
      world.seasonsWithoutCutoffs.delete('season-mn-2');
      app.raiderIo.reset();

      await app.app.get(MplusService).sweep();

      expect(
        requests('season-mn-2')
          .map((request) => request.region)
          .sort(),
      ).toEqual(['eu', 'us']);
      expect((await cutoffsFor('season-mn-2', 'us'))?.status).toBe('ok');
    });

    it('is settled once the archive reads a finished season as having none', async () => {
      world.seasonsWithoutCutoffs.add('season-mn-1');
      await db
        .collection(MPLUS_SEASONS_COLLECTION)
        .updateOne({ slug: 'season-mn-1' }, { $unset: { cutoffs: '' } });
      app.raiderIo.reset();

      await app.app.get(MplusArchiveService).archiveBacklog();
      const us = (await cutoffsFor('season-mn-1', 'us'))!;
      expect(us).toMatchObject({ status: 'missing', finalised: true });

      app.raiderIo.reset();
      await app.app.get(MplusArchiveService).archiveBacklog();
      expect(requests('season-mn-1'), 'never asked again').toEqual([]);
      world.seasonsWithoutCutoffs.delete('season-mn-1');
    });
  });

  describe('a region that keeps failing', () => {
    it('is retried on every pass while its season is live, and never given up on', async () => {
      await db
        .collection(MPLUS_SEASONS_COLLECTION)
        .updateOne({ slug: 'season-mn-2' }, { $unset: { cutoffs: '' } });

      for (let attempt = 0; attempt < 4; attempt += 1) {
        app.raiderIo.failWith('season-cutoffs', { status: 500 });
        await app.app.get(MplusService).sweep();
        app.raiderIo.reset();
      }
      expect(await cutoffsFor('season-mn-2', 'us')).toMatchObject({
        status: 'failed',
        attempts: 4,
      });

      await app.app.get(MplusService).sweep();
      expect((await cutoffsFor('season-mn-2', 'us'))?.status, 'read once it recovers').toBe('ok');
    });

    it('is given up on after three final reads of a finished season', async () => {
      // China answers 500 — not 404 — for every season before `season-df-4`,
      // which without a cap would be asked again on every tick.
      await db
        .collection(MPLUS_SEASONS_COLLECTION)
        .updateOne({ slug: 'season-mn-1' }, { $unset: { cutoffs: '' } });
      const statuses: (string | undefined)[] = [];

      for (let attempt = 0; attempt < 3; attempt += 1) {
        app.raiderIo.failWith('season-cutoffs', { status: 500, times: 2 });
        // Once for the backfill, which reads each region that owes a read.
        await app.app.get(MplusArchiveService).archiveBacklog();
        app.raiderIo.reset();
        statuses.push((await cutoffsFor('season-mn-1', 'us'))?.status);
      }

      expect(statuses).toEqual(['failed', 'failed', 'unavailable']);

      await app.app.get(MplusArchiveService).archiveBacklog();
      expect(requests('season-mn-1'), 'given up on, so no longer asked').toEqual([]);
      expect((await cutoffsFor('season-mn-1', 'us'))?.attempts).toBe(3);
    });
  });
});
