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

  it('M9.1 [decide] a realm slug in another case is not found today', async () => {
    expect(await character('us/area-52/healer1')).not.toBeNull();

    const exact = await sync({ realmSlug: 'area-52', characterName: 'Healer1' });
    const cased = await sync({ realmSlug: 'Area-52', characterName: 'Healer1' });

    expect(exact.status).toBe(200);
    // The key is built with the realm as given, so this reads as "not tracked".
    // Decide: normalise it, or refuse it with a 400 that says why.
    expect(cased.status).toBe(404);
  });

  it('M9.2 [decide] a name in decomposed Unicode is not found today', async () => {
    expect(await character(`us/stormrage/${NFC_NAME.toLowerCase()}`)).not.toBeNull();

    expect(NFD_NAME, 'two encodings of one name').not.toBe(NFC_NAME);
    const composed = await sync({ realmSlug: 'stormrage', characterName: NFC_NAME });
    const decomposed = await sync({ realmSlug: 'stormrage', characterName: NFD_NAME });

    expect(composed.status).toBe(200);
    // Keys are lowercased, not normalised. Decide on NFC at every key-building
    // site at once — the fold, `rosterKeys` and here — or the others become
    // unreachable.
    expect(decomposed.status).toBe(404);
  });

  it('M9.3 [decide] a dungeon the season does not list is accepted today, past the season count', async () => {
    const season = await db.collection(MPLUS_SEASONS_COLLECTION).findOne({ slug: SEASON });
    const listed = new Set(season!.dungeonIds as number[]);
    const unlisted = Array.from({ length: listed.size + 1 }, (_unused, index) => 50_000 + index);
    expect(unlisted.some((id) => listed.has(id))).toBe(false);

    const response = await sync({
      realmSlug: 'zuljin',
      characterName: 'Alsoregular',
      dungeonRuns: unlisted.map((id) => run(id, 100)),
    });

    // Decide: refuse it with 400, or accept it and document that coverage can
    // exceed the season's own list.
    expect(response.status).toBe(200);
    expect(response.body.dungeonsCovered).toBeGreaterThan(listed.size);
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
