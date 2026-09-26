import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MongoNetworkError, type Db } from 'mongodb';

import { IngestionCoordinator } from '../src/common/ingestion-coordinator.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_AFFIXES_COLLECTION } from '../src/mplus/entities/mplus-affix.entity.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusRepository } from '../src/mplus/mplus.repository.js';
import { MplusService, type MplusSweepResult } from '../src/mplus/mplus.service.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { MPLUS_SPEC_REPRESENTATION_COLLECTION } from '../src/mplus-representation/entities/mplus-spec-representation.entity.js';
import { MPLUS_SEASONS_COLLECTION } from '../src/mplus-season/entities/mplus-season.entity.js';
import { bootTestApp, type TestApp } from './support/app.js';
import {
  expectInvariants,
  expectMplusCharacterKeysWellFormed,
  expectMplusRegionsCoherent,
  expectMplusRosterKeysMirrorRoster,
  expectMplusStoredMatchesServed,
  expectNoOrphanMplusCharacters,
} from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import {
  member,
  MplusWorld,
  WORLD_DUNGEONS,
  type MplusWorldMember,
} from './support/mplus-world.js';
import { World } from './support/world.js';

const SEASON = 'season-mn-2';
const FINISHED = 'season-mn-1';
const MAX_PAGES = 5;

/**
 * M2.1-M2.11, M7.3, M10.7, M10.10 — one pass, looked at closely: what it asks
 * for, and what it makes of payloads that are not regular.
 *
 * Every seeded run is five members on one region with a real spec. The payload
 * traps of `SKILLS.md` §9.9-§9.15 were all found in real data, so each case
 * here builds the board it needs by hand: rosters of four and six, Legion's
 * spec placeholder, a tournament realm, a board that moves under the pass.
 *
 * Three pages a batch, so a batch boundary falls inside every five-page pass.
 */
describe('Mythic+ pass over irregular payloads', () => {
  let app: TestApp;
  let db: Db;
  const logger = new CapturingLogger();
  const world = new MplusWorld();

  const pass = async (): Promise<MplusSweepResult> => {
    const result = await app.app.get(MplusService).sweep();
    expect(result).not.toBeNull();

    return result!;
  };
  const character = (name: string, region = 'us', realm = 'stormrage') =>
    db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .findOne({ season: SEASON, key: `${region}/${realm}/${name.toLowerCase()}` });
  const run = (keystoneRunId: number) =>
    db.collection(MPLUS_RUNS_COLLECTION).findOne({ season: SEASON, keystoneRunId });
  const fillers = (tag: string, from: number, count = 4): MplusWorldMember[] =>
    Array.from({ length: count }, (_unused, offset) => member(from + offset, `${tag}${offset}`));

  const resetBoard = async () => {
    world.runs = [];
    for (const collection of [
      MPLUS_RUNS_COLLECTION,
      MPLUS_CHARACTERS_COLLECTION,
      MPLUS_SPEC_REPRESENTATION_COLLECTION,
    ]) {
      await db.collection(collection).deleteMany({});
    }
  };

  const representation = (dungeonId: number | null) =>
    db
      .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
      .findOne({ season: SEASON, region: 'us', dungeonId });

  beforeAll(async () => {
    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      { RAIDERIO_REGIONS: 'us', RAIDERIO_PAGE_BATCH: '3', RAIDERIO_CONCURRENCY: '3' },
      undefined,
      logger,
      world,
    );
    db = app.app.get(MongoService).db;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    app.raiderIo.reset();
    logger.clear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M2.1 rosters of four and of six are stored as served, and counted as served', async () => {
    await resetBoard();
    const four = world.addRun({
      region: 'us',
      season: SEASON,
      score: 500,
      dungeon: 0,
      members: fillers('Four', 1_000),
    });
    const six = world.addRun({
      region: 'us',
      season: SEASON,
      score: 490,
      dungeon: 1,
      members: fillers('Six', 1_100, 6),
    });

    await pass();

    expect((await run(four.keystoneRunId))!.roster).toHaveLength(4);
    expect((await run(six.keystoneRunId))!.roster).toHaveLength(6);
    expect(
      await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments({ season: SEASON }),
    ).toBe(10);
    // Slots are counted, never derived as runs x 5 (§9.15).
    expect((await representation(WORLD_DUNGEONS[0].id))!.slots).toBe(4);
    expect((await representation(WORLD_DUNGEONS[1].id))!.slots).toBe(6);
    expect((await representation(null))!.slots).toBe(10);

    await expectMplusRosterKeysMirrorRoster(db);
    await expectInvariants(db);
  });

  it('M2.2 M2.3 M7.3 the spec placeholder and a realm Blizzard does not list, end to end', async () => {
    await resetBoard();
    const traps = world.addRun({
      region: 'us',
      season: SEASON,
      score: 500,
      dungeon: 2,
      members: [
        member(2_001, 'Nospec', { specPlaceholder: true }),
        member(2_002, 'Tourney', { realmSlug: 'tournament-realm', wowRealmId: null }),
        ...fillers('Plain', 2_100, 3),
      ],
    });

    await pass();

    const stored = (await run(traps.keystoneRunId))!;
    const nospecSlot = stored.roster.find(
      (slot: { characterName: string }) => slot.characterName === 'Nospec',
    );
    expect(nospecSlot).toMatchObject({ specId: null, specName: null });
    const tourneySlot = stored.roster.find(
      (slot: { characterName: string }) => slot.characterName === 'Tourney',
    );
    expect(tourneySlot).toMatchObject({ realmId: null, anonymized: false });

    // M2.2: no spec anywhere it would otherwise be copied.
    const nospec = (await character('Nospec'))!;
    expect(nospec.profile.specId).toBeNull();
    expect(nospec.dungeonRuns[0].specId).toBeNull();

    // M2.3: stored, not dropped, and not mistaken for an anonymised player.
    const tourney = (await character('Tourney', 'us', 'tournament-realm'))!;
    expect(tourney).not.toBeNull();
    expect(tourney.realmId).toBeNull();
    expect(stored.rosterKeys).toContain(tourney.key);

    // M7.3: the placeholder slot is a slot, but not a classified one.
    const figures = (await representation(WORLD_DUNGEONS[2].id))!;
    expect(figures.slots).toBe(5);
    expect(figures.classified).toBe(4);
    expect(
      figures.specs.reduce((sum: number, spec: { percent: number }) => sum + spec.percent, 0),
    ).toBeCloseTo(100, 1);
    await expectInvariants(db);
  });

  it("M2.4 a character's best run per dungeon folds across batch boundaries", async () => {
    await resetBoard();
    world.seed('us', 100, 1_000, SEASON);
    const folder = member(3_001, 'Folder');
    // Page 0: the best run in dungeon A. Page 4: a worse one in A, which must
    // not win for arriving later, in a later batch. Page 3: the only run in B.
    const best = world.addRun({
      region: 'us',
      season: SEASON,
      score: 990.5,
      dungeon: 0,
      members: [folder, ...fillers('Fa', 3_100)],
    });
    world.addRun({
      region: 'us',
      season: SEASON,
      score: 905.5,
      dungeon: 0,
      members: [folder, ...fillers('Fb', 3_200)],
    });
    const onlyB = world.addRun({
      region: 'us',
      season: SEASON,
      score: 930.5,
      dungeon: 1,
      members: [folder, ...fillers('Fc', 3_300)],
    });

    await pass();

    const pages = app.raiderIo.requests
      .filter((request) => request.path === 'mythic-plus/runs')
      .map((request) => request.page);
    expect(pages.sort()).toEqual([0, 1, 2, 3, 4]);

    const stored = (await character('Folder'))!;
    expect(
      stored.dungeonRuns.map((entry: { dungeon: { id: number }; keystoneRunId: number }) => [
        entry.dungeon.id,
        entry.keystoneRunId,
      ]),
    ).toEqual([
      [WORLD_DUNGEONS[0].id, best.keystoneRunId],
      [WORLD_DUNGEONS[1].id, onlyB.keystoneRunId],
    ]);
    expect(stored.mythicScore).toBe(990.5 + 930.5);
    await expectMplusStoredMatchesServed(db, world, {
      season: SEASON,
      region: 'us',
      maxPages: MAX_PAGES,
    });
  });

  it('M2.6 a board that grows under the pass stores the doubled run once, and prunes only what left', async () => {
    await resetBoard();
    world.seed('us', 100, 1_000, SEASON);
    await pass();

    let inserted = false;
    app.raiderIo.beforeServe = (request) => {
      if (inserted || request.path !== 'mythic-plus/runs' || request.page !== 3) return;
      inserted = true;
      world.addRun({
        region: 'us',
        season: SEASON,
        score: 2_000,
        members: fillers('Newtop', 3_400, 5),
      });
    };

    const newTop = () => world.runs.find((entry) => entry.score === 2_000)!;
    const result = await pass();

    // Pages 0-2 were read before the insert, 3-4 after: the last run of page 2
    // is served again as the first of page 3, and stored once.
    expect(result.regions[0].runs, 'ranking entries read').toBe(100);
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ season: SEASON })).toBe(99);
    // The new top run landed on a page already read, so this pass never saw it.
    expect(await run(newTop().keystoneRunId)).toBeNull();
    // The run pushed from rank 100 to 101 left the window, and only that one.
    expect(result.regions[0].prunedRuns).toBe(1);
    expect(await run(world.runs.find((entry) => entry.score === 901)!.keystoneRunId)).toBeNull();

    // The next pass reads the board as it now is.
    await pass();
    expect(await run(newTop().keystoneRunId)).not.toBeNull();
    await expectMplusStoredMatchesServed(db, world, {
      season: SEASON,
      region: 'us',
      maxPages: MAX_PAGES,
    });
  });

  it('M2.6 a board that shrinks under the pass prunes a run that is still ranked, until the next pass', async () => {
    await resetBoard();
    world.seed('us', 100, 1_000, SEASON);
    await pass();

    // A page-0 run disappears after pages 0-2 were read: everything below it
    // moves up one, and the first run of page 3 moves onto page 2, already read.
    let removed = false;
    const skipped = world.runs.find((entry) => entry.score === 940)!;
    app.raiderIo.beforeServe = (request) => {
      if (removed || request.path !== 'mythic-plus/runs' || request.page !== 3) return;
      removed = true;
      world.removeRuns((entry) => entry.score === 995);
    };

    const gone = world.runs.length;
    const result = await pass();
    expect(world.runs.length).toBe(gone - 1);

    // The run that slid above the read cursor while still ranked: nothing
    // refreshed it, so it reads as gone. The run that really went was read on
    // page 0 before it went, so it stays until the next pass.
    expect(result.regions[0].prunedRuns).toBe(1);
    expect(await run(skipped.keystoneRunId)).toBeNull();
    // Its own members, named by no other run, go with it; the regulars on every
    // run keep that dungeon and lose no score.
    expect(await character(skipped.roster[0].name, 'us', skipped.roster[0].realmSlug)).toBeNull();
    const regular = (await character('Regular', 'us', 'illidan'))!;
    expect(regular.dungeonsCovered).toBe(3);

    // The next pass restores the skipped run and prunes the one that went.
    const next = await pass();
    expect(next.regions[0].prunedRuns).toBe(1);
    expect(await run(skipped.keystoneRunId)).not.toBeNull();
    expect(
      await character(skipped.roster[0].name, 'us', skipped.roster[0].realmSlug),
    ).not.toBeNull();
    await expectNoOrphanMplusCharacters(db);
  });

  it('M2.7 an affix reworded upstream is updated in place', async () => {
    await resetBoard();
    const reworded = { id: 9, name: 'Tyrannical (revised)', slug: 'tyrannical' };
    world.seed('us', 20, 500, SEASON);
    await pass();
    const referencing = await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ affixIds: 9 });

    for (const entry of world.runs)
      entry.affixes = [reworded, { id: 10, name: 'Fortified', slug: 'fortified' }];
    await pass();

    const affixes = await db.collection(MPLUS_AFFIXES_COLLECTION).find({ id: 9 }).toArray();
    expect(affixes).toHaveLength(1);
    expect(affixes[0]).toMatchObject({ name: 'Tyrannical (revised)' });
    expect(affixes[0].description).toMatch(/revised/);
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ affixIds: 9 })).toBe(
      referencing,
    );
    await expectInvariants(db);
  });

  it('M2.8 a respec follows the character; each run keeps the spec it was played on', async () => {
    await resetBoard();
    const shifter = member(4_001, 'Shifter', { specId: 258 });
    const a = world.addRun({
      region: 'us',
      season: SEASON,
      score: 500,
      dungeon: 0,
      members: [shifter, ...fillers('Sa', 4_100)],
    });
    world.addRun({
      region: 'us',
      season: SEASON,
      score: 480,
      dungeon: 1,
      members: [shifter, ...fillers('Sb', 4_200)],
    });
    await pass();

    // The dungeon-B run leaves the window. The character respecs, and its new
    // best run — above A, so the first of its runs the pass sees — is on 256.
    // A finished run never changes spec, so A stays as it was played.
    world.removeRuns((entry) => entry.dungeonId === WORLD_DUNGEONS[1].id);
    expect(a.roster[0].specId).toBe(258);
    world.addRun({
      region: 'us',
      season: SEASON,
      score: 510,
      dungeon: 2,
      members: [{ ...shifter, specId: 256 }, ...fillers('Sc', 4_300)],
    });
    await pass();

    const stored = (await character('Shifter'))!;
    expect(stored.profile.specId).toBe(256);
    const specs = Object.fromEntries(
      stored.dungeonRuns.map((entry: { dungeon: { id: number }; specId: number }) => [
        entry.dungeon.id,
        entry.specId,
      ]),
    );
    expect(specs).toEqual({
      [WORLD_DUNGEONS[0].id]: 258,
      // Kept from the earlier pass, with the spec it was played on.
      [WORLD_DUNGEONS[1].id]: 258,
      [WORLD_DUNGEONS[2].id]: 256,
    });
  });

  it('M2.9 a rename becomes a new key, and the old one leaves once no run names it', async () => {
    await resetBoard();
    const before = member(5_001, 'Oldname');
    const a = world.addRun({
      region: 'us',
      season: SEASON,
      score: 500,
      dungeon: 0,
      members: [before, ...fillers('Ra', 5_100)],
    });
    world.addRun({
      region: 'us',
      season: SEASON,
      score: 480,
      dungeon: 1,
      members: [before, ...fillers('Rb', 5_200)],
    });
    await pass();
    expect((await character('Oldname'))!.dungeonsCovered).toBe(2);

    // Renamed; the dungeon-B run has left the window meanwhile.
    world.removeRuns((entry) => entry.dungeonId === WORLD_DUNGEONS[1].id);
    a.roster[0] = { ...before, name: 'Newname' };
    await pass();

    expect(await character('Oldname')).toBeNull();
    const renamed = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .find({ season: SEASON, rioCharacterId: 5_001 })
      .toArray();
    expect(renamed.map((doc) => doc.characterName)).toEqual(['Newname']);
    // Kept dungeons do not follow a rename: the character is keyed on its name.
    expect(renamed[0].dungeonsCovered).toBe(1);
    await expectNoOrphanMplusCharacters(db);
  });

  it('M2.11 every request is the one the design says, at the concurrency configured', async () => {
    await resetBoard();
    world.seed('us', 100, 500, SEASON);
    app.raiderIo.delayMs = 20;

    await pass();

    const runs = app.raiderIo.requests.filter((request) => request.path === 'mythic-plus/runs');
    expect(runs).toHaveLength(MAX_PAGES);
    for (const request of runs) {
      expect(request.params).toEqual({
        season: SEASON,
        region: 'us',
        dungeon: 'all',
        page: request.page,
      });
    }
    expect(app.raiderIo.peakInFlight).toBe(3);
    expect(
      app.raiderIo.requests.filter(
        (request) => request.season !== null && request.season !== SEASON,
      ),
      'no side event, no uncatalogued slug',
    ).toEqual([]);
  });

  it('M10.7 schema drift on one page fails that page, not the pass — live and archived', async () => {
    await resetBoard();
    world.seed('us', 100, 500, SEASON).seed('us', 60, 400, FINISHED);
    await pass();
    const drift = { rankings: 'not an array' };

    app.raiderIo.corrupt(`mythic-plus/runs&season:${SEASON}&page:2`, drift, 1);
    const drifted = await pass();

    expect(drifted.regions[0].pagesFailed).toBe(1);
    expect(drifted.regions[0].pagesFetched).toBe(MAX_PAGES - 1);
    expect(drifted.regions[0].prunedRuns, 'a failed page means no prune').toBe(0);
    const warning = logger.of('warn', /Mythic\+ page 2 for us failed/);
    expect(warning).toHaveLength(1);
    expect(warning[0].message).toMatch(/schema issues: rankings:/);

    const clean = await pass();
    expect(clean.regions[0].pagesFailed).toBe(0);

    app.raiderIo.corrupt(`mythic-plus/runs&season:${FINISHED}&page:2`, drift, 1);
    await app.app.get(MplusArchiveService).archiveBacklog();
    const archive = (await db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug: FINISHED }))!
      .archive;
    expect(archive.status).toBe('incomplete');
    expect(archive.regions.us).toMatchObject({ status: 'incomplete', failedPages: [2] });
  });

  it('M10.10 Mongo going away mid-pass fails the pass cleanly, and the next one runs', async () => {
    await resetBoard();
    world.seed('us', 100, 500, SEASON);
    const coordinator = app.app.get(IngestionCoordinator);
    const repository = app.app.get(MplusRepository);
    const real = repository.upsertRuns.bind(repository);
    let calls = 0;
    // Batch 2 of the region: the first write succeeds, the second finds no server.
    const spy = vi.spyOn(repository, 'upsertRuns').mockImplementation(async (runs) => {
      calls += 1;
      if (calls === 2) throw new MongoNetworkError('connection 3 to 127.0.0.1:27017 closed');

      return real(runs);
    });

    let waiterReleased = false;
    const sweep = app.app.get(MplusService).sweep();
    const waiter = coordinator.whenMplusIdle().then(() => (waiterReleased = true));
    await expect(sweep).rejects.toThrow(/connection 3 .* closed/);
    await waiter;

    expect(waiterReleased, 'a waiting transition is not left stuck').toBe(true);
    expect(app.app.get(MplusService).isRunning).toBe(false);
    expect(coordinator.isMplusActive).toBe(false);

    spy.mockRestore();
    const next = await pass();
    expect(next.stoppedEarly).toBeNull();
    await expectInvariants(db);
  });

  it('M2.10 a roster member from another region is filed under the board, keyed under its own', async () => {
    await resetBoard();
    world.addRun({
      region: 'us',
      season: SEASON,
      score: 500,
      members: [member(6_001, 'Visitor', { region: 'eu' }), ...fillers('Host', 6_100)],
    });

    await pass();

    // Pinned as it is today, not as it should be: whether this happens live is
    // X5's question, and the design choice waits on the answer.
    const visitor = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .findOne({ season: SEASON, key: 'eu/stormrage/visitor' });
    expect(visitor).toMatchObject({ region: 'us', key: 'eu/stormrage/visitor' });
    await expect(expectMplusRegionsCoherent(db)).rejects.toThrow(/I24/);
    await expect(expectMplusCharacterKeysWellFormed(db)).rejects.toThrow(/I17/);

    // Out of the way of every later invariant check in this file.
    await resetBoard();
  });
});
