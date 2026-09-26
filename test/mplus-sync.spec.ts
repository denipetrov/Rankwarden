import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { IngestionCoordinator } from '../src/common/ingestion-coordinator.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../src/mplus/entities/mplus-character.entity.js';
import { MplusService } from '../src/mplus/mplus.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson, postJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { MplusWorld } from './support/mplus-world.js';
import { World } from './support/world.js';

const KEY = 'us/illidan/regular';

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

function payload(overrides: Record<string, unknown> = {}) {
  return {
    season: 'season-mn-2',
    region: 'us',
    realmSlug: 'illidan',
    characterName: 'Regular',
    dungeonRuns: [],
    ...overrides,
  };
}

describe('POST /mplus/characters/sync', () => {
  let app: TestApp;
  let mplus: MplusService;
  let db: Db;
  const mplusWorld = new MplusWorld();

  beforeAll(async () => {
    mplusWorld.seed('us', 40, 500);

    app = await bootTestApp(
      World.seed({ regions: ['us'], players: 20 }),
      { RAIDERIO_REGIONS: 'us' },
      undefined,
      undefined,
      mplusWorld,
    );
    mplus = app.app.get(MplusService);
    db = app.app.get(MongoService).db;
    await app.listen();
    // The endpoint never creates a character, so there has to be one first.
    await mplus.sweep();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('404s for a character no leaderboard lists', async () => {
    const response = await postJson(
      app.url(),
      '/mplus/characters/sync',
      payload({ characterName: 'Nobodyatall' }),
    );

    // The same rule as the PvP endpoint: creating one here would fill the
    // collection with players the boards do not rank.
    expect(response.status).toBe(404);
  });

  it('400s on a payload that does not match the schema', async () => {
    const response = await postJson(app.url(), '/mplus/characters/sync', {
      ...payload(),
      region: 'world',
    });

    expect(response.status).toBe(400);
  });

  it('adds a dungeon the character did not have, and raises the score', async () => {
    const before = await db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ key: KEY });

    const response = await postJson<{
      addedDungeons: number;
      mythicScore: number;
      dungeonsCovered: number;
    }>(app.url(), '/mplus/characters/sync', payload({ dungeonRuns: [run(9_503, 600)] }));

    expect(response.status).toBe(200);
    expect(response.body.addedDungeons).toBe(1);
    expect(response.body.dungeonsCovered).toBe((before!.dungeonsCovered as number) + 1);
    expect(response.body.mythicScore).toBe(
      Math.round(((before!.mythicScore as number) + 600) * 10) / 10,
    );

    const stored = await db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ key: KEY });
    expect(stored!.mythicScore).toBe(response.body.mythicScore);
  });

  it('never lowers a score, however poor the pushed run is', async () => {
    const before = await db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ key: KEY });

    // A worse run for a dungeon they already hold. The stored one wins.
    const response = await postJson<{ mythicScore: number }>(
      app.url(),
      '/mplus/characters/sync',
      payload({ dungeonRuns: [run(9_503, 1)] }),
    );

    expect(response.status).toBe(200);
    expect(response.body.mythicScore).toBe(before!.mythicScore);
  });

  it('replaces a dungeon entry when the pushed run is better', async () => {
    const response = await postJson<{ mythicScore: number }>(
      app.url(),
      '/mplus/characters/sync',
      payload({ dungeonRuns: [run(9_503, 900, 424_242)] }),
    );

    expect(response.status).toBe(200);

    const stored = await db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ key: KEY });
    const entry = (
      stored!.dungeonRuns as { dungeon: { id: number }; keystoneRunId: number }[]
    ).find((item) => item.dungeon.id === 9_503);

    expect(entry!.keystoneRunId).toBe(424_242);
  });

  it('leaves dungeons the payload does not mention alone', async () => {
    const before = await db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ key: KEY });

    // The deliberate difference from the PvP endpoint, where an omitted bracket
    // means "left that ladder". Here omission means nothing new to say.
    await postJson(app.url(), '/mplus/characters/sync', payload({ dungeonRuns: [run(9_503, 5)] }));

    const after = await db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ key: KEY });
    expect(after!.dungeonsCovered).toBe(before!.dungeonsCovered);
    expect(after!.mythicScore).toBe(before!.mythicScore);
  });

  it('merges the profile field by field', async () => {
    const before = await db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ key: KEY });

    await postJson(
      app.url(),
      '/mplus/characters/sync',
      payload({ profile: { specId: 63, specName: 'Fire' } }),
    );

    const after = await db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ key: KEY });
    const profile = after!.profile as Record<string, unknown>;

    expect(profile.specId).toBe(63);
    expect(profile.specName).toBe('Fire');
    // An absent field leaves what is stored; it does not blank it.
    expect(profile.className).toBe((before!.profile as Record<string, unknown>).className);
  });

  it('clears a profile field on an explicit null', async () => {
    await postJson(app.url(), '/mplus/characters/sync', payload({ profile: { specName: null } }));

    const after = await db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ key: KEY });
    expect((after!.profile as Record<string, unknown>).specName).toBeNull();
  });

  it('recomputes the derived fields rather than trusting the caller', async () => {
    // `mythicScore` and `dungeonsCovered` are stripped as unknown keys, the same
    // rule `ratings` follows on the PvP side, so they cannot be forged.
    const response = await postJson<{ mythicScore: number }>(app.url(), '/mplus/characters/sync', {
      ...payload(),
      mythicScore: 999_999,
      dungeonsCovered: 99,
    });

    expect(response.status).toBe(200);
    expect(response.body.mythicScore).not.toBe(999_999);

    const stored = await db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ key: KEY });
    expect(stored!.dungeonsCovered).not.toBe(99);
    expect(stored!.mythicScore).toBe(response.body.mythicScore);
  });

  it('accepts a document read straight back from the database', async () => {
    // Round-tripping matters for a caller that reads, edits one field and pushes.
    const stored = await db.collection(MPLUS_CHARACTERS_COLLECTION).findOne({ key: KEY });
    const response = await postJson(app.url(), '/mplus/characters/sync', {
      ...stored,
      _id: undefined,
    });

    expect(response.status).toBe(200);
  });

  it('409s while a Mythic+ pass is running', async () => {
    const coordinator = app.app.get(IngestionCoordinator);

    await coordinator.duringMplus(async () => {
      const response = await postJson(app.url(), '/mplus/characters/sync', payload());

      // The pass's own write is a read-merge-write; a push landing between the
      // two halves would lose whichever arrived first.
      expect(response.status).toBe(409);
    });
  });

  it('does not appear on the PvP sync route', async () => {
    const response = await getJson(app.url(), '/mplus/characters/sync');

    // GET is not mapped; the point is that the two endpoints are separate paths
    // and a PvP payload can never reach the M+ collection.
    expect(response.status).toBe(404);
  });

  it('leaves every invariant holding', async () => {
    await expectInvariants(db);
  });
});
