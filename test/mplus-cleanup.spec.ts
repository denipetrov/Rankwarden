import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';

import { IngestionCoordinator } from '../src/common/ingestion-coordinator.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { MplusRepository } from '../src/mplus/mplus.repository.js';
import { MplusService, type MplusSweepResult } from '../src/mplus/mplus.service.js';
import { MPLUS_SPEC_REPRESENTATION_COLLECTION } from '../src/mplus-representation/entities/mplus-spec-representation.entity.js';
import { bootTestApp, type TestApp } from './support/app.js';
import {
  expectInvariants,
  expectMplusRunsSelfContained,
  expectMplusStoredMatchesServed,
  expectNoOrphanMplusCharacters,
  snapshotMplusCharacters,
} from './support/invariants.js';
import { CapturingLogger } from './support/logger.js';
import { member, MplusWorld, type MplusWorldMember } from './support/mplus-world.js';
import { World } from './support/world.js';

const SEASON = 'season-mn-2';
const MAX_PAGES = 5;
const ENV = { RAIDERIO_REGIONS: 'us,eu' };

/** mulberry32: a small seeded PRNG, so a failing random case can be replayed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * M3.3-M3.10 — cleanup and monotonicity over several passes.
 *
 * Every path here deletes something, and deletion is where a guard that is
 * right in isolation can still be wrong in sequence. So each case is a small
 * sequence of passes over a board built for it, ending on the invariants, and
 * on I18 and I22 by name wherever the pass was clean.
 */
describe('Mythic+ cleanup over passes', () => {
  let app: TestApp;
  let db: Db;
  let mplus: MplusService;
  let repository: MplusRepository;
  const world = new MplusWorld();
  const pvp = World.seed({ regions: ['us'], players: 5 });
  const logger = new CapturingLogger();

  const boot = async () => {
    app = await bootTestApp(pvp, ENV, undefined, logger, world);
    db = app.app.get(MongoService).db;
    mplus = app.app.get(MplusService);
    repository = app.app.get(MplusRepository);
  };

  /** A clean board: nothing served, nothing stored. */
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

  const pass = async (): Promise<MplusSweepResult> => {
    const result = await mplus.sweep();
    expect(result, 'the pass must not be skipped').not.toBeNull();

    return result!;
  };

  const region = (result: MplusSweepResult, name: string) =>
    result.regions.find((entry) => entry.region === name)!;

  const character = (region: string, name: string) =>
    db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .findOne({ season: SEASON, key: `${region}/stormrage/${name.toLowerCase()}` });

  /** Four one-off members, so a run's other slots name nobody else. */
  const fillers = (tag: string, from: number): MplusWorldMember[] =>
    [0, 1, 2, 3].map((offset) => member(from + offset, `${tag}${offset}`));

  const expectServed = async (regionName: string, before?: Map<string, Map<number, number>>) =>
    expectMplusStoredMatchesServed(db, world, {
      season: SEASON,
      region: regionName,
      maxPages: MAX_PAGES,
      before,
    });

  beforeAll(boot);

  afterEach(() => {
    vi.restoreAllMocks();
    app.raiderIo.reset();
    logger.clear();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M3.3 prunes a board that genuinely shrinks, exactly', async () => {
    await resetBoard();
    world.seed('us', 40, 500, SEASON);
    // Straddle is on a run that stays and on one that goes. The one that goes
    // is Straddle's only run in its dungeon, so it is kept as a dangling
    // reference rather than lost (§5.6).
    world.addRun({
      region: 'us',
      score: 490.5,
      dungeon: 0,
      season: SEASON,
      members: [member(8_001, 'Straddle'), ...fillers('Stay', 8_100)],
    });
    world.addRun({
      region: 'us',
      score: 470.5,
      dungeon: 1,
      season: SEASON,
      members: [member(8_001, 'Straddle'), ...fillers('Gone', 8_200)],
    });
    expect((await pass()).stoppedEarly).toBeNull();
    const before = await snapshotMplusCharacters(db, SEASON, 'us');

    // The bottom half of the seeded board leaves, and Straddle's second run
    // with it.
    const removed = world.removeRuns((run) => run.region === 'us' && run.score <= 480.5);
    expect(removed).toHaveLength(21);

    // The first clean pass to miss them only marks them; nobody is removed yet.
    const marked = region(await pass(), 'us');
    expect(marked).toMatchObject({ missedRuns: 21, prunedRuns: 0, prunedCharacters: 0 });
    expect(await character('us', 'Tank25'), 'kept through the grace pass').not.toBeNull();

    // The second prunes them.
    const result = await pass();
    const us = region(result, 'us');

    expect(us.prunedRuns).toBe(21);
    // Tank, Healer and Dps of the 20 seeded runs that left, and the four
    // others on Straddle's: everyone named only by a run that is gone.
    expect(us.prunedCharacters).toBe(64);
    expect(await character('us', 'Tank25')).toBeNull();
    expect(await character('us', 'Gone0')).toBeNull();

    const straddle = await character('us', 'Straddle');
    expect(straddle, 'still named by a surviving run').not.toBeNull();
    expect(straddle!.dungeonsCovered, 'the dungeon that left is kept').toBe(2);
    expect(us.mergedCharacters).toBe(1);

    await expectNoOrphanMplusCharacters(db);
    await expectServed('us', before);
    await expectInvariants(db);
  });

  it('M3.4 no stored score ever falls over three seeded random passes', async () => {
    await resetBoard();
    const random = prng(20_260_925);
    const pool = Array.from({ length: 40 }, (_unused, index) =>
      member(9_000 + index, `Pool${index}`),
    );
    const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)];
    const rosterOf = () => {
      const chosen = new Set<MplusWorldMember>();
      while (chosen.size < 5) chosen.add(pick(pool));

      return [...chosen];
    };
    const addRandomRun = () =>
      world.addRun({
        region: 'us',
        season: SEASON,
        score: 300 + Math.round(random() * 3_000) / 10,
        dungeon: Math.floor(random() * 3),
        members: rosterOf(),
      });

    for (let index = 0; index < 60; index += 1) addRandomRun();
    expect((await pass()).stoppedEarly).toBeNull();
    await expectServed('us');

    const scores = async () =>
      new Map(
        (await db.collection(MPLUS_CHARACTERS_COLLECTION).find({ season: SEASON }).toArray()).map(
          (doc) => [doc.key as string, doc.mythicScore as number],
        ),
      );
    let previous = await scores();
    const recreated = new Set<string>();

    for (let round = 1; round <= 3; round += 1) {
      const before = await snapshotMplusCharacters(db, SEASON, 'us');

      // Ten leave, ten arrive, fifteen change score in either direction — and
      // the board stays inside the window, so every run is served.
      for (let index = 0; index < 10; index += 1) {
        const gone = pick(world.runs);
        world.removeRuns((run) => run === gone);
      }
      for (let index = 0; index < 10; index += 1) addRandomRun();
      for (let index = 0; index < 15; index += 1) {
        const run = pick(world.runs);
        run.score = Math.max(1, Math.round((run.score + (random() - 0.5) * 80) * 10) / 10);
      }
      expect(world.runs.length).toBeLessThanOrEqual(MAX_PAGES * 20);

      expect((await pass()).stoppedEarly, `round ${round}`).toBeNull();
      const current = await scores();

      for (const key of previous.keys()) if (!current.has(key)) recreated.add(key);
      for (const [key, score] of current) {
        if (recreated.has(key) || !previous.has(key)) continue;
        expect(score, `round ${round}: ${key} must not lose score`).toBeGreaterThanOrEqual(
          previous.get(key)!,
        );
      }

      await expectServed('us', before);
      await expectInvariants(db);
      previous = current;
    }
  });

  it('M3.5 rebuilds a character pruned and then seen again from the window alone', async () => {
    await resetBoard();
    const phoenix = member(7_001, 'Phoenix');
    const own = [0, 1, 2].map((dungeon) =>
      world.addRun({
        region: 'us',
        season: SEASON,
        score: 400 - dungeon * 10,
        dungeon,
        members: [phoenix, ...fillers(`P${dungeon}x`, 7_100 + dungeon * 10)],
      }),
    );
    // Someone else on the board, so the region is never empty.
    world.addRun({
      region: 'us',
      season: SEASON,
      score: 300,
      members: fillers('Other', 7_500).concat(member(7_600, 'Anchor')),
    });

    await pass();
    expect((await character('us', 'Phoenix'))!.mythicScore).toBe(1_170);

    world.removeRuns((run) => own.includes(run));
    // Two clean passes: the first marks the runs, the second prunes them.
    await pass();
    await pass();
    expect(await character('us', 'Phoenix'), 'no run names Phoenix any more').toBeNull();

    world.addRun({
      region: 'us',
      season: SEASON,
      score: 350,
      dungeon: 0,
      members: [phoenix, ...fillers('Back', 7_700)],
    });
    await pass();

    // The one way a score goes down: the character was deleted, and nothing
    // of what it held survives the deletion.
    const back = await character('us', 'Phoenix');
    expect(back!.dungeonsCovered).toBe(1);
    expect(back!.mythicScore).toBe(350);
    await expectInvariants(db);
  });

  it("M3.6 one region's failed page does not stop another region's prune", async () => {
    await resetBoard();
    world.seed('us', 30, 500, SEASON).seed('eu', 30, 480, SEASON);
    await pass();

    world.removeRuns((run) => run.region === 'us' && run.score <= 475);
    world.removeRuns((run) => run.region === 'eu' && run.score <= 455);
    app.raiderIo.failWith('mythic-plus/runs&region:eu', { status: 500, times: 1 });

    const result = await pass();
    expect(region(result, 'us').missedRuns).toBe(5);
    expect(region(result, 'eu').pagesFailed).toBe(1);
    expect(region(result, 'eu')).toMatchObject({ missedRuns: 0, prunedRuns: 0 });
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ region: 'eu' })).toBe(30);

    // The US, missed twice, is pruned; Europe's first clean pass only marks.
    const next = await pass();
    expect(region(next, 'us').prunedRuns).toBe(5);
    expect(region(next, 'eu').missedRuns).toBe(5);

    const last = await pass();
    expect(region(last, 'eu').prunedRuns).toBe(5);
    await expectNoOrphanMplusCharacters(db);
    await expectInvariants(db);
  });

  it('M3.8 a pass that dies mid-region leaves nothing half-written that a reader sees', async () => {
    await resetBoard();
    world.seed('us', 30, 500, SEASON).seed('eu', 20, 480, SEASON);
    await pass();
    const charactersBefore = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .find({}, { projection: { _id: 0 } })
      .sort({ key: 1 })
      .toArray();

    world.addRun({ region: 'us', season: SEASON, score: 999, members: fillers('Fresh', 7_900) });
    vi.spyOn(repository, 'upsertCharacters').mockRejectedValueOnce(
      new Error('injected write failure'),
    );

    await expect(mplus.sweep()).rejects.toThrow(/injected write failure/);

    const coordinator = app.app.get(IngestionCoordinator);
    expect(mplus.isRunning).toBe(false);
    expect(coordinator.isMplusActive).toBe(false);
    await coordinator.whenMplusIdle();

    // Runs are written before characters, so the new run is there; the
    // characters are exactly as the last pass left them.
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ score: 999 })).toBe(1);
    expect(
      await db
        .collection(MPLUS_CHARACTERS_COLLECTION)
        .find({}, { projection: { _id: 0 } })
        .sort({ key: 1 })
        .toArray(),
    ).toEqual(charactersBefore);
    await expectNoOrphanMplusCharacters(db);
    await expectInvariants(db);
    await expectMplusRunsSelfContained(db);

    const next = await pass();
    expect(next.stoppedEarly).toBeNull();
    expect(await character('us', 'Fresh0')).not.toBeNull();
    await expectNoOrphanMplusCharacters(db);
  });

  it('M3.9 three identical passes change nothing but timestamps', async () => {
    await resetBoard();
    world.seed('us', 30, 500, SEASON);
    // A tie on purpose, with one character on both runs: the fold keeps the
    // first seen, the merge keeps the stored one, and either way the choice
    // must not flip from pass to pass.
    for (const tag of ['TieA', 'TieB']) {
      world.addRun({
        region: 'us',
        season: SEASON,
        score: 1_000,
        dungeon: 0,
        members: [member(7_300, 'Tied'), ...fillers(tag, tag === 'TieA' ? 7_310 : 7_320)],
      });
    }

    const read = async () => ({
      runs: await db
        .collection(MPLUS_RUNS_COLLECTION)
        .find({}, { projection: { _id: 0, fetchedAt: 0 } })
        .sort({ keystoneRunId: 1 })
        .toArray(),
      characters: await db
        .collection(MPLUS_CHARACTERS_COLLECTION)
        .find({}, { projection: { _id: 0, updatedAt: 0 } })
        .sort({ key: 1 })
        .toArray(),
    });

    await pass();
    const first = await read();
    const tiedRun = (await character('us', 'Tied'))!.dungeonRuns[0].keystoneRunId;

    for (let index = 0; index < 2; index += 1) {
      const result = await pass();
      const us = region(result, 'us');

      expect(us.prunedRuns).toBe(0);
      expect(us.prunedCharacters).toBe(0);
      expect(us.mergedCharacters).toBe(0);
      expect(await read()).toEqual(first);
    }

    expect((await character('us', 'Tied'))!.dungeonRuns[0].keystoneRunId).toBe(tiedRun);
    await expectInvariants(db);
  });

  it('M3.10 mergedCharacters counts the characters that kept a dungeon, and the log says so', async () => {
    await resetBoard();
    const [c1, c2, c3] = [
      member(7_401, 'Keeper'),
      member(7_402, 'Holder'),
      member(7_403, 'Stayer'),
    ];
    const dungeonA = [c1, c2, c3].map((character, index) =>
      world.addRun({
        region: 'us',
        season: SEASON,
        score: 450 - index,
        dungeon: 0,
        members: [character, ...fillers(`A${index}x`, 7_410 + index * 10)],
      }),
    );
    for (const [index, character] of [c1, c2, c3].entries()) {
      world.addRun({
        region: 'us',
        season: SEASON,
        score: 420 - index,
        dungeon: 1,
        members: [character, ...fillers(`B${index}x`, 7_450 + index * 10)],
      });
    }
    await pass();

    // Each loses its dungeon-A run from the window; one also gains a better
    // dungeon-B run, which changes its score but not whether it kept A.
    world.removeRuns((run) => dungeonA.includes(run));
    world.addRun({
      region: 'us',
      season: SEASON,
      score: 440,
      dungeon: 1,
      members: [c1, ...fillers('Better', 7_490)],
    });

    const result = await pass();
    expect(region(result, 'us').mergedCharacters).toBe(3);
    expect(logger.matching(/Mythic\+ us: .*3 kept a dungeon that left the window/)).toHaveLength(1);
    expect((await character('us', 'Keeper'))!.mythicScore).toBe(450 + 440);

    // Not "merged this pass": a character still holding a dungeon outside the
    // window is counted on every pass it does, which is what makes the number
    // climb when the window is outrunning the ladder.
    const unchanged = await pass();
    expect(region(unchanged, 'us').mergedCharacters).toBe(3);

    // Once the window is back to what is stored, nothing is kept.
    await resetBoard();
    world.seed('us', 20, 500, SEASON);
    await pass();
    logger.clear();
    const settled = await pass();
    expect(region(settled, 'us').mergedCharacters).toBe(0);
    expect(logger.matching(/kept a dungeon that left the window/)).toHaveLength(0);
  });

  /** Two populated regions, then Europe's whole board answering `{"rankings": []}`. */
  const emptyEurope = async () => {
    await resetBoard();
    world.seed('us', 30, 500, SEASON).seed('eu', 30, 480, SEASON);
    await pass();
    const before = {
      runs: await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ region: 'eu' }),
      characters: await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments({ region: 'eu' }),
    };
    world.removeRuns((run) => run.region === 'eu');

    return { before, result: await pass() };
  };

  it('M3.1 [F2] a populated region answering an empty board keeps it, and says so', async () => {
    const { before, result } = await emptyEurope();
    const eu = region(result, 'eu');

    expect(before.runs).toBe(30);
    expect(eu).toMatchObject({
      stoppedEarly: 'the board came back empty',
      runs: 0,
      prunedRuns: 0,
      missedRuns: 0,
      prunedCharacters: 0,
    });
    // Reported, so readiness degrades rather than calling the pass clean.
    expect(result.stoppedEarly).toBe('the board came back empty');
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ region: 'eu' })).toBe(
      before.runs,
    );
    expect(await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments({ region: 'eu' })).toBe(
      before.characters,
    );
    // The US read normally and was not held back by Europe.
    expect(region(result, 'us').stoppedEarly).toBeNull();
    await expectNoOrphanMplusCharacters(db);
  });

  it('M3.1 [F2] a region that was never populated is simply empty, not short', async () => {
    await resetBoard();
    world.seed('us', 30, 500, SEASON);

    const result = await pass();

    expect(region(result, 'eu')).toMatchObject({ stoppedEarly: null, runs: 0 });
    expect(result.stoppedEarly).toBeNull();
  });

  it('M3.2 [F2] stage 1 refuses on its own when the pass refreshed nothing', async () => {
    await resetBoard();
    world.seed('us', 30, 500, SEASON);
    await pass();

    // No run carries a `fetchedAt` at or after `before`: nothing was refreshed.
    const pruned = await repository.pruneStale(SEASON, 'us', new Date());

    expect(pruned).toEqual({ runs: 0, missed: 0, characters: 0 });
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ region: 'us' })).toBe(30);
    expect(
      await db
        .collection(MPLUS_RUNS_COLLECTION)
        .countDocuments({ region: 'us', missedSince: { $exists: true } }),
      'and marks nothing either',
    ).toBe(0);
  });

  it('M3.7 a crash between the two prune stages is healed by the next clean pass', async () => {
    await resetBoard();
    world.seed('us', 30, 500, SEASON).seed('eu', 20, 480, SEASON);
    await pass();

    world.removeRuns((run) => run.region === 'us' && run.score <= 480);
    // One clean pass marks the runs that left...
    await pass();
    // ...and on the next, stage 1 deletes them and the process dies before stage 2.
    vi.spyOn(repository, 'removeCharactersWithoutRuns').mockRejectedValueOnce(
      new Error('process killed'),
    );
    await expect(mplus.sweep()).rejects.toThrow(/process killed/);
    vi.restoreAllMocks();
    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({ region: 'us' })).toBe(20);

    await app.close();
    await boot();

    // The crash window: characters named by no run exist until the next pass.
    await expect(expectNoOrphanMplusCharacters(db)).rejects.toThrow(/I18/);
    const survivors = await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments({
      region: 'us',
      key: {
        $in: await db.collection(MPLUS_RUNS_COLLECTION).distinct('rosterKeys', { region: 'us' }),
      },
    });

    const healed = await pass();
    expect(healed.stoppedEarly).toBeNull();
    await expectNoOrphanMplusCharacters(db);
    expect(
      await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments({ region: 'us' }),
      'nobody who still has a run was removed',
    ).toBe(survivors);
    await expectInvariants(db);
  });
});
