import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { MPLUS_SEASONS_COLLECTION } from '../src/mplus-season/entities/mplus-season.entity.js';
import { MplusCatalogueService } from '../src/mplus-season/mplus-catalogue.service.js';
import { MplusSeasonTransitionService } from '../src/mplus-season/mplus-season-transition.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { holdActive, releaseAllHolds } from './support/hold.js';
import { postJson } from './support/http.js';
import {
  expectInvariants,
  expectMplusStoredMatchesServed,
  snapshotMplusCharacters,
} from './support/invariants.js';
import { member, MplusWorld, WORLD_DUNGEONS } from './support/mplus-world.js';
import { World } from './support/world.js';

const SEASON = 'season-mn-2';
/** One name, two encodings: precomposed ë, and e followed by a combining diaeresis. */
const NFC_NAME = 'Zeph'.replace('e', 'ë').normalize('NFC');
const NFD_NAME = NFC_NAME.normalize('NFD');
/** A second name, which Raider.io is made to serve decomposed. */
const SERVED_NFD = 'Noel'.replace('e', '\u00eb').normalize('NFD');

/** A run payload the sync endpoint accepts, shaped as a stored `dungeonRuns` entry. */
function run(dungeonId: number, score: number, keystoneRunId = dungeonId * 100) {
  return {
    dungeon: {
      id: dungeonId,
      name: `Dungeon ${dungeonId}`,
      slug: `dungeon-${dungeonId}`,
      shortName: 'DGN',
    },
    keystoneRunId,
    mythicLevel: 25,
    score,
    clearTimeMs: 1_500_000,
    timeRemainingMs: 60_000,
    numChests: 2,
    completedAt: '2026-09-14T08:00:00.000Z',
    specId: 62,
    role: 'dps',
  };
}

/**
 * M9.1-M9.5 — what a real search API will send that the contract cases in
 * `mplus-sync.spec.ts` do not.
 *
 * Three of these end in a decision rather than an assertion. Each pins what
 * happens today, says so, and is written so that making the decision means
 * changing the expectation rather than discovering it: a silent 404 is the one
 * answer none of them should keep.
 */
describe('POST /mplus/characters/sync — edge inputs', () => {
  let app: TestApp;
  let db: Db;
  const world = new MplusWorld();

  const sync = (body: Record<string, unknown>) =>
    postJson<{ key?: string; mythicScore?: number; dungeonsCovered?: number; message?: string }>(
      app.url(),
      '/mplus/characters/sync',
      { season: SEASON, region: 'us', dungeonRuns: [], ...body },
    );
  const character = (key: string, season = SEASON) =>
    db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ season, key });

  beforeAll(async () => {
    world.seed('us', 40, 500);
    // Stored in NFC, as Raider.io serves names.
    // And one served decomposed, which the fold must key composed.
    world.addRun({
      region: 'us',
      score: 499.4,
      members: [
        member(7_201, SERVED_NFD),
        ...[1, 2, 3, 4].map((n) => member(7_300 + n, `Band${n}`)),
      ],
    });
    world.addRun({
      region: 'us',
      score: 499.5,
      members: [
        member(7_001, NFC_NAME),
        ...[1, 2, 3, 4].map((n) => member(7_100 + n, `Party${n}`)),
      ],
    });

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 5 }),
      {
        RAIDERIO_REGIONS: 'us',
        MPLUS_PURGE_DRY_RUN: 'false',
        MPLUS_PURGE_REQUIRE_ARCHIVE: 'false',
      },
      undefined,
      undefined,
      world,
    );
    db = app.app.get(MongoService).db;
    await app.listen();
    await app.app.get(MplusService).sweep();
  });

  afterEach(async () => {
    await releaseAllHolds();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('M9.1 a realm slug in another case finds the same character', async () => {
    expect(await character('us/area-52/healer1')).not.toBeNull();

    const exact = await sync({ realmSlug: 'area-52', characterName: 'Healer1' });
    const cased = await sync({ realmSlug: 'Area-52', characterName: 'Healer1' });

    expect(exact.status).toBe(200);
    expect(cased.status).toBe(200);
    expect(cased.body.key).toBe('us/area-52/healer1');
  });

  it('M9.2 a name in decomposed Unicode finds the same character, and is stored composed', async () => {
    expect(await character(`us/stormrage/${NFC_NAME.toLowerCase()}`)).not.toBeNull();

    expect(NFD_NAME, 'two encodings of one name').not.toBe(NFC_NAME);
    const composed = await sync({ realmSlug: 'stormrage', characterName: NFC_NAME });
    const decomposed = await sync({ realmSlug: 'stormrage', characterName: NFD_NAME });

    expect(composed.status).toBe(200);
    expect(decomposed.status).toBe(200);
    expect(decomposed.body.key).toBe(composed.body.key);
    const stored = (await character(`us/stormrage/${NFC_NAME.toLowerCase()}`))!;
    expect(stored.characterName, 'the push did not rewrite the name decomposed').toBe(NFC_NAME);

    // Served decomposed, found by the composed spelling a search API sends.
    const served = await sync({
      realmSlug: 'stormrage',
      characterName: SERVED_NFD.normalize('NFC'),
    });
    expect(served.status).toBe(200);
    expect(served.body.key).toBe(`us/stormrage/${SERVED_NFD.normalize('NFC').toLowerCase()}`);
    await expectInvariants(db);
  });

  it('M9.3 a dungeon the season does not list is refused, naming it', async () => {
    const season = await db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug: SEASON });
    const listed = season!.dungeonIds as number[];
    const before = (await character('us/zuljin/alsoregular'))!;

    const response = await sync({
      realmSlug: 'zuljin',
      characterName: 'Alsoregular',
      dungeonRuns: [run(listed[3], 100), run(50_000, 100), run(50_001, 100)],
    });

    expect(response.status).toBe(400);
    expect(response.body.message).toMatch(/does not list dungeon\(s\) 50000, 50001/);
    // Refused whole: not even the listed dungeon was taken.
    expect((await character('us/zuljin/alsoregular'))!.dungeonRuns).toEqual(before.dungeonRuns);

    const listedOnly = await sync({
      realmSlug: 'zuljin',
      characterName: 'Alsoregular',
      dungeonRuns: [run(listed[3], 100)],
    });
    expect(listedOnly.status).toBe(200);
    expect(listedOnly.body.dungeonsCovered).toBeLessThanOrEqual(listed.length);
    await expectInvariants(db);
  });

  it('M9.5 a better run pushed by sync survives the next pass', async () => {
    const dungeon = WORLD_DUNGEONS[0].id;
    const before = await character('us/illidan/regular');
    const served = (before!.dungeonRuns as { dungeon: { id: number }; score: number }[]).find(
      (entry) => entry.dungeon.id === dungeon,
    )!.score;

    const pushed = await sync({
      realmSlug: 'illidan',
      characterName: 'Regular',
      dungeonRuns: [
        {
          ...run(dungeon, served + 50, 999_001),
          dungeon: {
            id: dungeon,
            name: WORLD_DUNGEONS[0].name,
            slug: WORLD_DUNGEONS[0].slug,
            shortName: null,
          },
        },
      ],
    });
    expect(pushed.status).toBe(200);
    const snapshot = await snapshotMplusCharacters(db, SEASON, 'us');

    const pass = await app.app.get(MplusService).sweep();
    expect(pass!.stoppedEarly).toBeNull();

    const after = (await character('us/illidan/regular'))!;
    const entry = (
      after.dungeonRuns as { dungeon: { id: number }; score: number; keystoneRunId: number }[]
    ).find((item) => item.dungeon.id === dungeon)!;
    // Kept over the board's own best: the merge is monotonic whoever wrote it.
    expect(entry).toMatchObject({ score: served + 50, keystoneRunId: 999_001 });
    expect(after.mythicScore).toBe(pushed.body.mythicScore);
    // The "held before this pass" branch of I22, exercised by exactly this.
    await expectMplusStoredMatchesServed(db, world, {
      season: SEASON,
      region: 'us',
      maxPages: 5,
      before: snapshot,
    });
    await expectInvariants(db);
  });

  it('M9.4 a sync during the archive is answered; after the transition it is not, and nothing comes back', async () => {
    // The archive never writes mplus_characters, so it does not block a push:
    // the 409 is for the live pass alone.
    holdActive(app.app, 'mplusArchive');
    const duringArchive = await sync({ realmSlug: 'illidan', characterName: 'Regular' });
    expect(duringArchive.status).toBe(200);
    await releaseAllHolds();

    const duringPass = holdActive(app.app, 'mplus');
    expect((await sync({ realmSlug: 'illidan', characterName: 'Regular' })).status).toBe(409);
    await duringPass();

    // The next season opens in the US and the transition retires this one there.
    world.seasons.push({
      slug: 'season-mn-3',
      name: 'MN Season 3',
      blizzardSeasonId: 19,
      isMainSeason: true,
      starts: { us: new Date(Date.now() - 60_000).toISOString() },
      ends: { us: '2030-01-01T00:00:00Z' },
      dungeons: 8,
    });
    await app.app.get(MplusCatalogueService).refresh();
    const { purged } = await app.app.get(MplusSeasonTransitionService).run();
    expect(purged.map((entry) => `${entry.season}/${entry.region}`)).toContain(`${SEASON}/us`);

    const afterPurge = await sync({ realmSlug: 'illidan', characterName: 'Regular' });
    expect(afterPurge.status).toBe(404);
    expect(
      await db.collection(MPLUS_CHARACTERS_COLLECTION).countDocuments({ season: SEASON }),
      'a sync never inserts, so the retired season stays retired',
    ).toBe(0);
  });
});
