import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import {
  CHARACTERS_COLLECTION,
  GUILDS_COLLECTION,
  HIDDEN_ENTRIES_COLLECTION,
  MPLUS_CHARACTERS_COLLECTION,
} from '../src/database/collections.js';
import { MongoService } from '../src/database/mongo.service.js';
import { HiddenRegistry } from '../src/hidden/hidden.registry.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { RaidRankingsService } from '../src/raid/raid-rankings.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { postJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

/** A Mythic+ character the world seeds, which a PvP player is renamed to match. */
const PLAYER = { region: 'us', realmSlug: 'stormrage', name: 'Tank0' } as const;
/** A guild on the world's raid boards. */
const ECHO = 1047044;

/**
 * Hiding a player or a guild: `POST /hidden`.
 *
 * A player is one name on one realm, hidden in PvP and Mythic+ alike; a guild
 * is its id. The list is kept, and every write follows it, so a document
 * created after the call — a new season's, or one re-earned — comes in hidden.
 */
describe('POST /hidden', () => {
  let app: TestApp;
  let db: Db;
  let pvpId: number;
  const mplusWorld = new MplusWorld();

  const pvp = () => db.collection(CHARACTERS_COLLECTION).findOne({ characterId: pvpId });
  const mplus = () =>
    db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ key: 'us/stormrage/tank0' });
  const guild = () => db.collection(GUILDS_COLLECTION).findOne({ id: ECHO });
  const sweep = async () => {
    expect(await app.app.get(LeaderboardService).sweep()).not.toBeNull();
  };
  const hide = (body: Record<string, unknown>) => postJson(app.url(), '/hidden', body);

  beforeAll(async () => {
    mplusWorld.seed('us', 10);
    const world = World.seed({ regions: ['us'], players: 20, seed: 41 });
    const player = [...world.players.values()][0]!;
    player.name = PLAYER.name;
    player.realmSlug = PLAYER.realmSlug;
    pvpId = player.id;

    app = await bootTestApp(
      world,
      { RAIDERIO_REGIONS: 'us', RAID_CATALOGUE_ENABLED: 'true', RAID_RANKINGS_ENABLED: 'true' },
      undefined,
      undefined,
      mplusWorld,
    );
    db = app.app.get(MongoService).db;
    await app.settle();
    await sweep();
    await app.app.get(MplusService).sweep();
    await app.settle();
    await app.app.get(RaidRankingsService).refreshDue();
    await app.listen();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await app?.close();
  });

  it('starts everyone visible', async () => {
    for (const name of [CHARACTERS_COLLECTION, MPLUS_CHARACTERS_COLLECTION, GUILDS_COLLECTION]) {
      expect(await db.collection(name).countDocuments({ hidden: { $ne: false } }), name).toBe(0);
    }
    expect(await guild()).not.toBeNull();
    await expectInvariants(db);
  });

  it('hides a player in PvP and Mythic+ at once, however the name is cased', async () => {
    const response = await hide({
      kind: 'character',
      region: PLAYER.region,
      realmSlug: PLAYER.realmSlug,
      name: 'TANK0',
      hidden: true,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      hidden: true,
      updated: { characters: 1, mplusCharacters: 1 },
    });
    expect((await pvp())!.hidden).toBe(true);
    expect((await mplus())!.hidden).toBe(true);
    // Nobody else.
    expect(await db.collection(CHARACTERS_COLLECTION).countDocuments({ hidden: true })).toBe(1);
    await expectInvariants(db);
  });

  it('keeps them hidden through the next sweep and Mythic+ pass', async () => {
    await sweep();
    await app.app.get(MplusService).sweep();

    expect((await pvp())!.hidden).toBe(true);
    expect((await mplus())!.hidden).toBe(true);
    await expectInvariants(db);
  });

  it('hides a document created after the call, as a new season or a re-earned ladder spot would', async () => {
    await db.collection(CHARACTERS_COLLECTION).deleteOne({ characterId: pvpId });
    await db.collection(MPLUS_CHARACTERS_COLLECTION).deleteOne({ key: 'us/stormrage/tank0' });

    await sweep();
    await app.app.get(MplusService).sweep();

    expect((await pvp())!.hidden).toBe(true);
    expect((await mplus())!.hidden).toBe(true);
  });

  it('is idempotent, and shows the player again everywhere', async () => {
    const body = { kind: 'character', ...PLAYER, hidden: true };
    expect((await hide(body)).status).toBe(200);
    expect(await db.collection(HIDDEN_ENTRIES_COLLECTION).countDocuments()).toBe(1);

    const shown = await hide({ ...body, hidden: false });

    expect(shown.status).toBe(200);
    expect((await pvp())!.hidden).toBe(false);
    expect((await mplus())!.hidden).toBe(false);
    expect(await db.collection(HIDDEN_ENTRIES_COLLECTION).countDocuments()).toBe(0);

    await sweep();
    expect((await pvp())!.hidden).toBe(false);
    await expectInvariants(db);
  });

  it('hides a guild by id, and keeps it hidden when its boards are read again', async () => {
    const response = await hide({ kind: 'guild', guildId: ECHO, hidden: true });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ updated: { guilds: 1 } });
    expect((await guild())!.hidden).toBe(true);

    await app.app.get(RaidRankingsService).refreshRaid('the-venomous-abyss');

    expect((await guild())!.hidden).toBe(true);
    expect(await db.collection(GUILDS_COLLECTION).countDocuments({ hidden: true })).toBe(1);
    await expectInvariants(db);
  });

  it('records a player or guild not stored yet rather than refusing it', async () => {
    const player = await hide({
      kind: 'character',
      region: 'cn',
      realmSlug: 'silvermoon',
      name: '风为',
      hidden: true,
    });
    const unknownGuild = await hide({ kind: 'guild', guildId: 999_999, hidden: true });

    expect(player.status).toBe(200);
    expect(player.body).toMatchObject({ updated: { characters: 0, mplusCharacters: 0 } });
    expect(unknownGuild.body).toMatchObject({ updated: { guilds: 0 } });
    expect(app.app.get(HiddenRegistry).isCharacterHidden('cn', 'silvermoon', '风为')).toBe(true);
    expect(app.app.get(HiddenRegistry).isGuildHidden(999_999)).toBe(true);
  });

  it('400s on a payload that names nothing, or says neither hidden nor shown', async () => {
    const bad = [
      { kind: 'character', region: 'us', realmSlug: 'stormrage', hidden: true },
      { kind: 'character', region: 'world', realmSlug: 'stormrage', name: 'x', hidden: true },
      { kind: 'guild', guildId: ECHO },
      { kind: 'guild', guildId: ECHO, hidden: 'yes' },
      { kind: 'realm', hidden: true },
    ];

    for (const body of bad) expect((await hide(body)).status, JSON.stringify(body)).toBe(400);
  });

  it('answers "who is hidden" from the hidden index', async () => {
    for (const [name, index] of [
      [CHARACTERS_COLLECTION, 'character_hidden'],
      [MPLUS_CHARACTERS_COLLECTION, 'mplus_character_hidden'],
      [GUILDS_COLLECTION, 'guild_hidden'],
    ] as const) {
      const plan = await db.collection(name).find({ hidden: true }).explain('queryPlanner');
      expect(JSON.stringify(plan.queryPlanner.winningPlan), name).toContain(index);
    }
  });

  it('defaults documents written before the field existed to visible, at boot', async () => {
    await db.collection(CHARACTERS_COLLECTION).updateMany({}, { $unset: { hidden: '' } });
    await db.collection(GUILDS_COLLECTION).updateMany({}, { $unset: { hidden: '' } });

    await app.app.get(HiddenRegistry).onModuleInit();

    expect(await db.collection(CHARACTERS_COLLECTION).countDocuments({ hidden: false })).toBe(
      await db.collection(CHARACTERS_COLLECTION).countDocuments(),
    );
    // Echo was hidden before its field was dropped, and nothing writes it until
    // its boards are read again: what the default gives it is visible.
    expect((await guild())!.hidden).toBe(false);
    await app.app.get(RaidRankingsService).refreshRaid('the-venomous-abyss');
    expect((await guild())!.hidden).toBe(true);
  });
});
