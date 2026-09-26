import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { MPLUS_ARCHIVE_RUNS_COLLECTION } from '../src/mplus-archive/entities/mplus-archive.entity.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { MPLUS_SPEC_REPRESENTATION_COLLECTION } from '../src/mplus-representation/entities/mplus-spec-representation.entity.js';
import { MPLUS_SEASONS_COLLECTION } from '../src/mplus-season/entities/mplus-season.entity.js';
import { bootTestApp, type TestApp } from './support/app.js';
import {
  expectInvariants,
  expectMplusArchiveRowsOwned,
  expectMplusCutoffsWellFormed,
  expectMplusRegionsCoherent,
  expectMplusRepresentationCoherent,
  expectMplusScoreMatchesRuns,
  expectMplusStoredMatchesServed,
} from './support/invariants.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const MAX_PAGES = 5;

/**
 * The Mythic+ invariants added with the test plan (I21-I25), each proven able
 * to fail.
 *
 * An invariant that has never failed has not been shown to check anything: a
 * query with a typo in a field name passes over any data at all. So each one is
 * run over a real pass and a real archive, where it must hold, and then over
 * the same data with exactly one thing broken, where it must not.
 */
describe('Mythic+ invariants I21-I25', () => {
  let app: TestApp;
  let db: Db;
  const world = new MplusWorld();

  beforeAll(async () => {
    // A live season on two boards, and a finished one for the archive to hold,
    // so representation, cutoffs and archive rows all exist to be checked.
    world
      .seed('us', 50, 500, 'season-mn-2')
      .seed('eu', 30, 480, 'season-mn-2')
      .seed('us', 30, 450, 'season-mn-1')
      .seed('eu', 20, 440, 'season-mn-1');

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAIDERIO_REGIONS: 'us,eu' },
      undefined,
      undefined,
      world,
    );
    db = app.app.get(MongoService).db;

    const pass = await app.app.get(MplusService).sweep();
    expect(pass!.stoppedEarly).toBeNull();
    const tick = await app.app.get(MplusArchiveService).archiveBacklog();
    expect(tick!.seasons.map((season) => season.outcome)).toEqual(['complete']);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('all hold over a real pass and a real archive', async () => {
    expect(
      await db.collection(MPLUS_SPEC_REPRESENTATION_COLLECTION).countDocuments(),
    ).toBeGreaterThan(0);
    expect(
      (await db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug: 'season-mn-2' }))?.cutoffs?.us
        ?.status,
    ).toBe('ok');

    await expectInvariants(db);
    await expectMplusCutoffsWellFormed(db, ['us', 'eu']);
    for (const region of ['us', 'eu']) {
      await expectMplusStoredMatchesServed(db, world, {
        season: 'season-mn-2',
        region,
        maxPages: MAX_PAGES,
      });
    }
  });

  it('I21 fails when one per-dungeon document stops adding up', async () => {
    const collection = db.collection(MPLUS_SPEC_REPRESENTATION_COLLECTION);
    const victim = await collection.findOne({ region: 'us', dungeonId: { $ne: null } });

    await collection.updateOne({ _id: victim!._id }, { $inc: { runs: 1 } });
    await expect(expectMplusRepresentationCoherent(db)).rejects.toThrow(/I21/);

    await collection.updateOne({ _id: victim!._id }, { $inc: { runs: -1 } });
    await expectMplusRepresentationCoherent(db);
  });

  it('I21 fails when a spec count and classified disagree', async () => {
    const collection = db.collection(MPLUS_SPEC_REPRESENTATION_COLLECTION);
    const victim = await collection.findOne({ region: 'eu', dungeonId: null });

    await collection.updateOne({ _id: victim!._id }, { $inc: { 'specs.0.count': 1 } });
    await expect(expectMplusRepresentationCoherent(db)).rejects.toThrow(/I21/);

    await collection.updateOne({ _id: victim!._id }, { $inc: { 'specs.0.count': -1 } });
  });

  it('I22 fails over data that is coherent and wrong, where I12 cannot', async () => {
    // A run's score lowered, together with the dungeon entry and the total built
    // on it: everything still adds up, so every self-consistency check passes.
    // Only a comparison with what was served can see it.
    const runs = db.collection(MPLUS_RUNS_COLLECTION);
    const characters = db.collection(MPLUS_CHARACTERS_COLLECTION);
    const character = await characters.findOne({
      season: 'season-mn-2',
      region: 'us',
      key: /regular$/,
    });
    const entry = (character!.dungeonRuns as { keystoneRunId: number; score: number }[])[0];

    await runs.updateOne(
      { season: 'season-mn-2', region: 'us', keystoneRunId: entry.keystoneRunId },
      { $inc: { score: -7 } },
    );
    await characters.updateOne(
      { _id: character!._id, 'dungeonRuns.keystoneRunId': entry.keystoneRunId },
      { $inc: { 'dungeonRuns.$.score': -7, mythicScore: -7 } },
    );

    await expectMplusScoreMatchesRuns(db);
    await expect(
      expectMplusStoredMatchesServed(db, world, {
        season: 'season-mn-2',
        region: 'us',
        maxPages: MAX_PAGES,
      }),
    ).rejects.toThrow(/I22/);

    await runs.updateOne(
      { season: 'season-mn-2', region: 'us', keystoneRunId: entry.keystoneRunId },
      { $inc: { score: 7 } },
    );
    await characters.updateOne(
      { _id: character!._id, 'dungeonRuns.keystoneRunId': entry.keystoneRunId },
      { $inc: { 'dungeonRuns.$.score': 7, mythicScore: 7 } },
    );
  });

  it('I22 fails when a served run is missing, or an unserved one is stored', async () => {
    const runs = db.collection(MPLUS_RUNS_COLLECTION);
    const victim = await runs.findOne({ season: 'season-mn-2', region: 'eu' });

    await runs.deleteOne({ _id: victim!._id });
    await expect(
      expectMplusStoredMatchesServed(db, world, {
        season: 'season-mn-2',
        region: 'eu',
        maxPages: MAX_PAGES,
      }),
    ).rejects.toThrow(/I22.*stores exactly the runs served/);

    await runs.insertOne({ ...victim!, keystoneRunId: 999_999 });
    await expect(
      expectMplusStoredMatchesServed(db, world, {
        season: 'season-mn-2',
        region: 'eu',
        maxPages: MAX_PAGES,
      }),
    ).rejects.toThrow(/I22/);

    await runs.deleteOne({ keystoneRunId: 999_999 });
    await runs.insertOne(victim!);
  });

  it('I23 fails when a status and its attempts disagree', async () => {
    const seasons = db.collection(MPLUS_SEASONS_COLLECTION);

    await seasons.updateOne(
      { slug: 'season-mn-2' },
      { $set: { 'cutoffs.us.status': 'failed', 'cutoffs.us.attempts': 0 } },
    );
    await expect(expectMplusCutoffsWellFormed(db)).rejects.toThrow(/I23/);

    await seasons.updateOne(
      { slug: 'season-mn-2' },
      {
        $set: {
          'cutoffs.us.status': 'unavailable',
          'cutoffs.us.attempts': 2,
          'cutoffs.us.lastError': 'x',
        },
      },
    );
    await expect(expectMplusCutoffsWellFormed(db)).rejects.toThrow(/I23/);

    await seasons.updateOne(
      { slug: 'season-mn-2' },
      {
        $set: { 'cutoffs.us.status': 'ok', 'cutoffs.us.attempts': 0 },
        $unset: { 'cutoffs.us.lastError': '' },
      },
    );
    await expectMplusCutoffsWellFormed(db);
  });

  it('I23 fails on a region that is not configured', async () => {
    await expect(expectMplusCutoffsWellFormed(db, ['us'])).rejects.toThrow(/I23.*configured/);
  });

  it('I24 fails when a character is filed under another region than its key', async () => {
    const characters = db.collection(MPLUS_CHARACTERS_COLLECTION);
    const victim = await characters.findOne({ region: 'us' });

    await characters.updateOne({ _id: victim!._id }, { $set: { region: 'eu' } });
    await expect(expectMplusRegionsCoherent(db)).rejects.toThrow(/I24/);

    await characters.updateOne({ _id: victim!._id }, { $set: { region: 'us' } });
    await expectMplusRegionsCoherent(db);
  });

  it('I25 fails on archived rows the marker does not name', async () => {
    const seasons = db.collection(MPLUS_SEASONS_COLLECTION);
    const season = await seasons.findOne({ slug: 'season-mn-1' });
    const archive = season!.archive as { regions: Record<string, unknown> };

    expect(
      await db
        .collection(MPLUS_ARCHIVE_RUNS_COLLECTION)
        .countDocuments({ season: 'season-mn-1', region: 'eu' }),
    ).toBeGreaterThan(0);

    // What `markUnarchivable` writes: a marker with no regions, over rows it
    // does not mention.
    await seasons.updateOne(
      { slug: 'season-mn-1' },
      { $set: { archive: { ...archive, status: 'unarchivable', regions: {} } } },
    );
    await expect(expectMplusArchiveRowsOwned(db)).rejects.toThrow(/I25/);

    await seasons.updateOne({ slug: 'season-mn-1' }, { $set: { archive } });
    await expectMplusArchiveRowsOwned(db);
  });

  it('all hold again once every break is undone', async () => {
    await expectInvariants(db);
  });
});
