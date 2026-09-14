import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MPLUS_AFFIXES_COLLECTION } from '../src/mplus/entities/mplus-affix.entity.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../src/mplus/entities/mplus-run.entity.js';
import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { MplusWorld } from './support/mplus-world.js';
import {
  expectInvariants,
  expectMplusRosterKeysMirrorRoster,
  expectMplusRunsSelfContained,
  expectNoOrphanMplusCharacters,
} from './support/invariants.js';
import { World } from './support/world.js';

/**
 * The Mythic+ pass, end to end: real `AppModule`, real Mongo, fake Raider.io at
 * the HTTP seam so the real zod schemas parse the payloads.
 */
describe('Mythic+ ingestion', () => {
  let app: TestApp;
  let mplus: MplusService;
  let db: ReturnType<MongoService['db']['collection']> extends never
    ? never
    : Awaited<ReturnType<typeof database>>;

  async function database() {
    return app.app.get(MongoService).db;
  }

  const mplusWorld = new MplusWorld();

  beforeAll(async () => {
    // Two regions, 60 runs each: enough for three pages at the harness's
    // 5-page ceiling to leave runs unreached, and enough repetition for one
    // character to hold several dungeons.
    mplusWorld.seed('us', 60, 500).seed('eu', 40, 480);

    app = await bootTestApp(
      World.seed({ regions: ['us', 'eu'], players: 20 }),
      { RAIDERIO_REGIONS: 'us,eu' },
      undefined,
      undefined,
      mplusWorld,
    );
    mplus = app.app.get(MplusService);
    db = await database();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('stores runs, characters and affixes from one pass', async () => {
    const result = await mplus.sweep();

    expect(result).not.toBeNull();
    expect(result!.season).toBe('season-mn-2');
    expect(result!.regions.map((region) => region.region)).toEqual(['us', 'eu']);

    const runs = await db.collection(MPLUS_RUNS_COLLECTION).countDocuments();
    expect(runs, 'every seeded run: 60 in us plus 40 in eu').toBe(100);

    const characters = await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments();
    expect(characters).toBeGreaterThan(0);
  });

  it('stops at the end of the data rather than at the page ceiling', async () => {
    // us holds 60 runs — three pages — against a 5-page ceiling, so pages 3 and
    // 4 come back empty. The pass has to read that as the end of the board and
    // stop, not as a board that lost its last two pages.
    const result = await mplus.sweep();
    const us = result!.regions.find((region) => region.region === 'us')!;

    expect(us.stoppedEarly, 'running out of data is not stopping early').toBeNull();
    expect(us.pagesPlanned).toBe(5);
    expect(us.runs).toBe(60);
    expect(us.prunedRuns, 'and nothing is pruned for the pages that held nothing').toBe(0);
  });

  it('keeps Mythic+ data out of the PvP characters collection', async () => {
    // The whole reason for a separate collection: Raider.io's character id is
    // not Blizzard's, and the PvP season purge deletes `characters` by
    // `{ seasonId, region }` with no type filter.
    const leaked = await db
      .collection(CHARACTERS_COLLECTION)
      .countDocuments({ characterType: 'M+' });

    expect(leaked).toBe(0);
  });

  it('stores affixes once and references them by id from every run', async () => {
    const affixes = await db.collection(MPLUS_AFFIXES_COLLECTION).find({}).toArray();

    expect(affixes.map((affix) => affix.id).sort((left, right) => left - right)).toEqual([9, 10]);
    expect(affixes.find((affix) => affix.id === 9)?.name).toBe('Tyrannical');

    const run = await db.collection(MPLUS_RUNS_COLLECTION).findOne({});
    expect(run?.affixIds).toEqual([9, 10]);
    expect(JSON.stringify(run), 'no description repeated onto the run').not.toContain(
      'Bosses have 25% more health',
    );
  });

  it('sums mythicScore over the best run in each dungeon', async () => {
    // `Regular` is in every seeded US run, so they hold the best run of each of
    // the three dungeons the world serves.
    const character = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .findOne({ region: 'us', nameKey: 'regular' });

    expect(character).not.toBeNull();
    expect(character!.dungeonsCovered).toBe(3);
    expect(character!.dungeonRuns).toHaveLength(3);

    const summed =
      Math.round(
        (character!.dungeonRuns as { score: number }[]).reduce((sum, run) => sum + run.score, 0) *
          10,
      ) / 10;
    expect(character!.mythicScore).toBe(summed);

    // Best per dungeon, not first seen: the top-scoring run of each.
    for (const run of character!.dungeonRuns as { dungeon: { id: number }; score: number }[]) {
      const better = await db.collection(MPLUS_RUNS_COLLECTION).countDocuments({
        region: 'us',
        'dungeon.id': run.dungeon.id,
        rosterKeys: 'us/illidan/regular',
        score: { $gt: run.score },
      });

      expect(better, 'no stored run of that dungeon scores higher').toBe(0);
    }
  });

  it('keeps anonymised players in the roster and out of the character board', async () => {
    const anonymousRuns = await db
      .collection(MPLUS_RUNS_COLLECTION)
      .countDocuments({ 'roster.anonymized': true });
    expect(anonymousRuns, 'the party is a fact, all five members').toBeGreaterThan(0);

    const withAnon = await db
      .collection(MPLUS_RUNS_COLLECTION)
      .findOne({ 'roster.anonymized': true });
    const anon = (withAnon!.roster as { anonymized: boolean; realmId: number | null }[]).find(
      (member) => member.anonymized,
    );
    expect(anon!.realmId, 'the anonymous realm carries no wowRealmId').toBeNull();

    const leaked = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .countDocuments({ realmSlug: 'anonymous' });
    expect(leaked).toBe(0);
  });

  it('is idempotent: a second pass rewrites rather than duplicates', async () => {
    const before = await db.collection(MPLUS_RUNS_COLLECTION).countDocuments();
    const charactersBefore = await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments();

    await mplus.sweep();

    expect(await db.collection(MPLUS_RUNS_COLLECTION).countDocuments()).toBe(before);
    expect(await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments()).toBe(
      charactersBefore,
    );
  });

  it('prunes runs that fall off the leaderboard, and the characters left in none', async () => {
    // `Tank0`..`Tank9` appear in exactly one run each, so dropping those runs
    // leaves them in nothing. `Regular` is in every run and must survive.
    const doomed = mplusWorld.runs.filter((run) => run.region === 'us').slice(0, 10);
    const doomedIds = doomed.map((run) => run.keystoneRunId);
    const strandedKeys = doomed.map((run) => `us/stormrage/${run.roster[0].name.toLowerCase()}`);

    expect(
      await db
        .collection(MPLUS_CHARACTERS_COLLECTION)
        .countDocuments({ key: { $in: strandedKeys } }),
      'they are stored before the runs go',
    ).toBe(strandedKeys.length);

    mplusWorld.runs = mplusWorld.runs.filter((run) => !doomedIds.includes(run.keystoneRunId));
    await mplus.sweep();

    expect(
      await db
        .collection(MPLUS_RUNS_COLLECTION)
        .countDocuments({ keystoneRunId: { $in: doomedIds } }),
      'runs no longer on the board are removed',
    ).toBe(0);

    expect(
      await db
        .collection(MPLUS_CHARACTERS_COLLECTION)
        .countDocuments({ key: { $in: strandedKeys } }),
      'and so are the characters no surviving run lists',
    ).toBe(0);

    expect(
      await db
        .collection(MPLUS_CHARACTERS_COLLECTION)
        .countDocuments({ key: 'us/illidan/regular' }),
      'but a character still in other runs stays',
    ).toBe(1);
  });

  it('holds a score when a dungeon drops out of the ingested window', async () => {
    // The monotonicity rule. `Regular` keeps their Den of Nalorakk entry even
    // though every run of that dungeon has left the board — they did not lose
    // the run, our window stopped showing it.
    const before = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .findOne({ key: 'us/illidan/regular' });
    expect(before!.dungeonsCovered).toBe(3);

    mplusWorld.runs = mplusWorld.runs.filter(
      (run) => !(run.region === 'us' && run.dungeonId === 16368),
    );

    const result = await mplus.sweep();
    const after = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .findOne({ key: 'us/illidan/regular' });

    expect(after!.mythicScore, 'the score does not fall').toBe(before!.mythicScore);
    expect(after!.dungeonsCovered).toBe(3);
    expect(
      (after!.dungeonRuns as { dungeon: { id: number } }[]).map((run) => run.dungeon.id),
      'the dropped dungeon is still credited',
    ).toContain(16368);

    // And the pass says so, rather than leaving it to be inferred.
    expect(
      result!.regions.find((region) => region.region === 'us')!.mergedCharacters,
    ).toBeGreaterThan(0);
  });

  it('leaves the kept dungeon pointing at a run that is no longer stored', async () => {
    // The documented consequence of the two rules together: `mplus_runs` mirrors
    // the current board, `dungeonRuns` remembers a best run once earned, so the
    // join is optional by design. Asserted so it cannot be "fixed" by accident.
    const character = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .findOne({ key: 'us/illidan/regular' });
    const dropped = (
      character!.dungeonRuns as { dungeon: { id: number }; keystoneRunId: number }[]
    ).find((run) => run.dungeon.id === 16368)!;

    expect(
      await db
        .collection(MPLUS_RUNS_COLLECTION)
        .countDocuments({ keystoneRunId: dropped.keystoneRunId }),
    ).toBe(0);
  });

  it('still raises a score when a better run arrives', async () => {
    // Monotonic must not mean frozen.
    const before = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .findOne({ key: 'us/illidan/regular' });

    mplusWorld.runs.push({
      keystoneRunId: 999_001,
      dungeonId: 9527,
      dungeonName: 'Temple of Sethraliss',
      dungeonSlug: 'temple-of-sethraliss',
      score: 9_000,
      mythicLevel: 30,
      region: 'us',
      roster: [
        {
          id: 3_001,
          name: 'Regular',
          realmSlug: 'illidan',
          wowRealmId: 57,
          classId: 8,
          specId: 62,
          role: 'dps',
        },
        {
          id: 7_001,
          name: 'Newtank',
          realmSlug: 'stormrage',
          wowRealmId: 60,
          classId: 6,
          specId: 250,
          role: 'tank',
        },
        {
          id: 7_002,
          name: 'Newheal',
          realmSlug: 'stormrage',
          wowRealmId: 60,
          classId: 2,
          specId: 65,
          role: 'healer',
        },
        {
          id: 7_003,
          name: 'Newdps',
          realmSlug: 'stormrage',
          wowRealmId: 60,
          classId: 5,
          specId: 258,
          role: 'dps',
        },
        {
          id: 7_004,
          name: 'Newdpstwo',
          realmSlug: 'stormrage',
          wowRealmId: 60,
          classId: 1,
          specId: 71,
          role: 'dps',
        },
      ],
    });

    await mplus.sweep();

    const after = await db
      .collection(MPLUS_CHARACTERS_COLLECTION)
      .findOne({ key: 'us/illidan/regular' });

    expect(after!.mythicScore).toBeGreaterThan(before!.mythicScore as number);
  });

  it('holds every invariant, including the Mythic+ ones', async () => {
    await expectInvariants(db);
    await expectMplusRunsSelfContained(db);
    await expectMplusRosterKeysMirrorRoster(db);
    await expectNoOrphanMplusCharacters(db);
  });
});
