import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { MongoService } from '../src/database/mongo.service.js';
import { MplusArchiveService } from '../src/mplus-archive/mplus-archive.service.js';
import { MplusRepository } from '../src/mplus/mplus.repository.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { postJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { MplusWorld, WORLD_DUNGEONS } from './support/mplus-world.js';
import { World } from './support/world.js';
import {
  MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
  MPLUS_CHARACTERS_COLLECTION,
} from '../src/database/collections.js';

/**
 * `isFullyCovered`: whether a character's stored runs cover every dungeon its
 * season lists, on the live board and in the archive, through every path that
 * writes runs — and for documents written before the flag existed.
 *
 * Both seasons list exactly the three dungeons the world plays, so a character
 * in every seeded run (`Regular`) covers all of them and a character in one run
 * (`Tank0`) covers one.
 */
describe('Mythic+ coverage flag', () => {
  let app: TestApp;
  let mplus: MplusService;
  let archive: MplusArchiveService;
  let db: Db;
  const mplusWorld = new MplusWorld();

  const live = () => db.collection(MPLUS_CHARACTERS_COLLECTION);
  const archived = () => db.collection(MPLUS_ARCHIVE_CHARACTERS_COLLECTION);

  beforeAll(async () => {
    for (const season of mplusWorld.seasons) season.dungeons = WORLD_DUNGEONS.length;
    mplusWorld.seed('us', 30, 500).seed('us', 12, 400, 'season-mn-1');

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 20 }),
      { RAIDERIO_REGIONS: 'us' },
      undefined,
      undefined,
      mplusWorld,
    );
    mplus = app.app.get(MplusService);
    archive = app.app.get(MplusArchiveService);
    db = app.app.get(MongoService).db;
    await app.listen();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('flags a live character complete only when its runs cover every dungeon', async () => {
    await mplus.sweep();

    const regular = await live().findOne({ season: 'season-mn-2', nameKey: 'regular' });
    const tank = await live().findOne({ season: 'season-mn-2', nameKey: 'tank0' });

    expect(regular!.dungeonsCovered).toBe(3);
    expect(regular!.isFullyCovered).toBe(true);
    expect(tank!.dungeonsCovered).toBe(1);
    expect(tank!.isFullyCovered).toBe(false);

    await expectInvariants(db, undefined, mplusWorld);
  });

  it('serves the complete board from its own index, in score order', async () => {
    const query = { season: 'season-mn-2', isFullyCovered: true };
    const board = await live().find(query).sort({ mythicScore: -1 }).toArray();

    expect(board.length).toBeGreaterThan(0);
    expect(board.every((character) => character.dungeonsCovered === 3)).toBe(true);

    const explained = await live()
      .find(query)
      .sort({ mythicScore: -1 })
      .limit(50)
      .explain('queryPlanner');
    const plan = JSON.stringify(
      (explained as { queryPlanner: { winningPlan: unknown } }).queryPlanner.winningPlan,
    );
    expect(plan).toContain('mplus_covered_board');
    expect(plan, 'index-ordered, not sorted in memory').not.toContain('"SORT"');
  });

  it('flags the archive, and restores a flag missing from an archived character', async () => {
    await archive.archiveBacklog();

    const regular = await archived().findOne({ season: 'season-mn-1', nameKey: 'regular' });
    expect(regular!.isFullyCovered).toBe(true);
    expect(await archived().countDocuments({ season: 'season-mn-1', isFullyCovered: false })).toBe(
      await archived().countDocuments({ season: 'season-mn-1', dungeonsCovered: { $lt: 3 } }),
    );

    // As a character archived before the flag existed: the archive never
    // rereads a finished season, so only the tick's own refresh can set it.
    await archived().updateMany({}, { $unset: { isFullyCovered: '' } });
    await archive.archiveBacklog();

    expect(await archived().countDocuments({ isFullyCovered: { $exists: false } })).toBe(0);
    expect(
      (await archived().findOne({ season: 'season-mn-1', nameKey: 'regular' }))!.isFullyCovered,
    ).toBe(true);

    await expectInvariants(db, undefined, mplusWorld);
  });

  it('re-derives the live flag where it is missing or wrong', async () => {
    await live().updateMany({ nameKey: 'regular' }, { $unset: { isFullyCovered: '' } });
    await live().updateMany({ nameKey: 'tank0' }, { $set: { isFullyCovered: true } });

    const corrected = await app.app
      .get(MplusRepository)
      .refreshCoverage('season-mn-2', WORLD_DUNGEONS.length);

    expect(corrected).toBe(2);
    expect((await live().findOne({ nameKey: 'regular' }))!.isFullyCovered).toBe(true);
    expect((await live().findOne({ nameKey: 'tank0' }))!.isFullyCovered).toBe(false);
    expect(
      await app.app.get(MplusRepository).refreshCoverage('season-mn-2', WORLD_DUNGEONS.length),
      'a settled season matches nothing',
    ).toBe(0);
  });

  it('flips the flag through the sync endpoint only once every dungeon is held', async () => {
    const tank = await live().findOne({ season: 'season-mn-2', nameKey: 'tank0' });
    const played = (tank!.dungeonRuns as { dungeon: { id: number } }[])[0].dungeon.id;
    const missing = WORLD_DUNGEONS.filter((dungeon) => dungeon.id !== played);
    expect(missing).toHaveLength(2);

    const sync = (dungeons: typeof missing, extra: Record<string, unknown> = {}) =>
      postJson<{ dungeonsCovered: number; isFullyCovered: boolean; addedDungeons: number }>(
        app.url(),
        '/mplus/characters/sync',
        {
          season: 'season-mn-2',
          region: 'us',
          realmSlug: 'stormrage',
          characterName: 'Tank0',
          dungeonRuns: dungeons.map((dungeon) => ({
            dungeon: { id: dungeon.id, name: dungeon.name, slug: dungeon.slug, shortName: null },
            keystoneRunId: 900_000 + dungeon.id,
            mythicLevel: 20,
            score: 300,
            clearTimeMs: 1_500_000,
            timeRemainingMs: 60_000,
            numChests: 1,
            completedAt: '2026-09-14T08:00:00.000Z',
            specId: 250,
            role: 'tank',
          })),
          ...extra,
        },
      );

    // One of the two missing dungeons, with a caller's claim that the character
    // is complete: the claim is dropped and the flag derived from the runs.
    const partial = await sync([missing[0]], { isFullyCovered: true, dungeonsCovered: 3 });
    expect(partial.status).toBe(200);
    expect(partial.body).toMatchObject({
      addedDungeons: 1,
      dungeonsCovered: 2,
      isFullyCovered: false,
    });
    let stored = await live().findOne({ season: 'season-mn-2', nameKey: 'tank0' });
    expect(stored!.dungeonsCovered).toBe(2);
    expect(stored!.isFullyCovered).toBe(false);

    // Only the last one: merged with the two already held, the season is whole.
    const last = await sync([missing[1]]);
    expect(last.status).toBe(200);
    expect(last.body).toMatchObject({ addedDungeons: 1, dungeonsCovered: 3, isFullyCovered: true });
    stored = await live().findOne({ season: 'season-mn-2', nameKey: 'tank0' });
    expect(stored!.dungeonsCovered).toBe(3);
    expect(stored!.isFullyCovered).toBe(true);

    // A sync that adds nothing new keeps it complete.
    const again = await sync([missing[1]]);
    expect(again.body).toMatchObject({ addedDungeons: 0, isFullyCovered: true });
    expect(
      (await live().findOne({ season: 'season-mn-2', nameKey: 'tank0' }))!.isFullyCovered,
    ).toBe(true);

    await expectInvariants(db, undefined, mplusWorld);
  });
});
