import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { ratingFamilyOf } from '../src/blizzard/blizzard.constants.js';
import {
  activeLoadoutsBySpec,
  characterProfileSchema,
  characterSpecializationsSchema,
} from '../src/blizzard/schemas/character-profile.schema.js';
import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../src/leaderboard/entities/rating.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import {
  expectInvariants,
  expectNoUnrankedCharacters,
  expectRatingsMirrorBrackets,
  expectStoredMatchesWorld,
} from './support/invariants.js';
import { World } from './support/world.js';
import { TEST_DB_PREFIX, assertTestDatabase } from './support/database.js';

/**
 * Proves the harness itself works before any scenario is written against it.
 *
 * If this file is red, nothing else in the integration suite can be trusted:
 * every later case assumes a World that serves realistic payloads, an app that
 * boots against a throwaway database, and invariants that actually inspect it.
 */
describe('integration harness', () => {
  let harness: TestApp;
  let db: Db;

  beforeAll(async () => {
    harness = await bootTestApp(World.seed({ regions: ['us', 'eu'], players: 120, seed: 7 }));
    db = harness.app.get(MongoService).db;
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  describe('safety', () => {
    it('runs against a throwaway database, never the development one', () => {
      expect(harness.dbName.startsWith(TEST_DB_PREFIX)).toBe(true);
      expect(db.databaseName).toBe(harness.dbName);
    });

    it('refuses a database name that is not a test one', () => {
      // The guard that stops a sweep writing into the real data because
      // ConfigModule fell back to .env.
      expect(() => assertTestDatabase('rankwarden')).toThrow(/Refusing to run/);
    });
  });

  describe('the world', () => {
    it('publishes the same 85 brackets Blizzard does', () => {
      // Verified against the live pvp-leaderboard index: 3 core, 2 aggregates
      // and 40 specs on both shuffle and blitz.
      const brackets = harness.world.brackets('us');

      expect(brackets).toHaveLength(85);
      expect(brackets).toContain('3v3');
      expect(brackets).toContain('shuffle-overall');
      expect(brackets).toContain('shuffle-mage-fire');
    });

    it('is deterministic for a given seed', () => {
      const first = World.seed({ seed: 99, players: 20 });
      const second = World.seed({ seed: 99, players: 20 });

      expect([...first.players.keys()]).toEqual([...second.players.keys()]);
      expect([...first.players.values()][0].ratings).toEqual(
        [...second.players.values()][0].ratings,
      );
    });

    it('staggers region start dates, as real regions do', () => {
      // The reason the season purge is scoped per region.
      expect(harness.world.season('eu').startsAt).toBeGreaterThan(
        harness.world.season('us').startsAt,
      );
    });

    it('omits season_end_timestamp while a season is running', () => {
      // Present-and-null would fail the real schema, so the fixture must not
      // invent a shape Blizzard never sends.
      const payload = harness.world.seasonPayload('us', harness.world.season('us').id);

      expect(payload).not.toHaveProperty('season_end_timestamp');
    });
  });

  describe('a sweep through the real pipeline', () => {
    beforeAll(async () => {
      const result = await harness.app.get(LeaderboardService).sweep();
      expect(result, 'the sweep must run').not.toBeNull();
    });

    it('ingests every bracket except the aggregates', async () => {
      // 83 ingestable ladders across two regions.
      const jobs = harness.blizzard.countMatching('/pvp-leaderboard/');
      expect(jobs).toBe(83 * 2 + 2); // +2 for the per-region bracket index

      const stored = await db.collection(CHARACTERS_COLLECTION).countDocuments();
      expect(stored).toBeGreaterThan(0);
    });

    it('holds every standing invariant', async () => {
      // With the world, this also runs I7 — every stored rating compared back
      // against the ladder the fake actually served.
      await expectInvariants(db, harness.world);
      await expectNoUnrankedCharacters(db);
    });

    it('I7 fails when stored data drifts from what was served', async () => {
      const victim = await db.collection(CHARACTERS_COLLECTION).findOne({});
      const bracket = Object.keys(victim!.ratings as Record<string, number>)[0];
      const family = ratingFamilyOf(bracket)!;

      const original = (victim!.ratings as Record<string, number>)[bracket];
      const write = async (rating: number) => {
        // All three places at once, so the corruption is internally consistent:
        // the payload, its mirror and the flat row all agree with each other and
        // only disagree with the ladder that was served.
        await db
          .collection(CHARACTERS_COLLECTION)
          .updateOne(
            { _id: victim!._id },
            { $set: { [`brackets.${bracket}.rating`]: rating, [`ratings.${bracket}`]: rating } },
          );
        await db
          .collection(RATING_COLLECTIONS[family])
          .updateOne({ characterId: victim!.characterId, bracket }, { $set: { rating } });
      };

      await write(9999);

      await expect(expectStoredMatchesWorld(db, harness.world)).rejects.toThrow(/I7/);

      // Every inward-looking check still passes over the corrupted data, which
      // is precisely why I7 has to exist.
      await expectRatingsMirrorBrackets(db);

      await write(original);
    });

    it('serves profile payloads the real schemas accept', () => {
      // Guards the whole enrichment area. Leaderboard payloads were covered by
      // the assertion below, profile ones were not — so three malformed fields
      // made every profile fetch fail validation and the gap only surfaced when
      // someone came to write S2. A shape drifting again fails here instead.
      const player = [...harness.world.players.values()][0];

      expect(() =>
        characterProfileSchema.parse(harness.world.profilePayload(player)),
      ).not.toThrow();
      expect(() =>
        characterSpecializationsSchema.parse(harness.world.specsPayload(player)),
      ).not.toThrow();
    });

    it('serves a profile the enrichment pass can actually store', () => {
      const player = [...harness.world.players.values()][0];
      const parsed = characterProfileSchema.parse(harness.world.profilePayload(player));
      const specs = characterSpecializationsSchema.parse(harness.world.specsPayload(player));

      // The fields the enrichment writes, so a payload that parses but carries
      // nothing useful is caught too.
      expect(parsed.realm.name).toBeTruthy();
      expect(parsed.active_title?.display_string).toBeTruthy();
      expect(activeLoadoutsBySpec(specs).length).toBeGreaterThan(0);
    });

    it('parsed the fake payloads with the real schemas', async () => {
      // The fake sits at the HTTP seam, so PvpApi and every zod schema ran.
      const sample = await db.collection(CHARACTERS_COLLECTION).findOne({});

      expect(sample).toMatchObject({
        region: expect.stringMatching(/^(us|eu)$/),
        characterName: expect.any(String),
        realmSlug: expect.any(String),
      });
      expect(Object.keys(sample!.ratings as object).length).toBeGreaterThan(0);
    });
  });

  describe('http', () => {
    it('serves the health endpoints over a real listener', async () => {
      const baseUrl = await harness.listen();

      const live = await getJson<{ status: string }>(baseUrl, '/health');
      expect(live.status).toBe(200);
      expect(live.body.status).toBe('ok');

      const ready = await getJson<{ status: string }>(baseUrl, '/health/ready');
      expect(ready.status).toBe(200);
      expect(ready.body.status).toBe('ok');
    });

    it('leaks no credential in a health payload', async () => {
      const ready = await getJson(harness.url(), '/health/ready');

      expect(ready.text).not.toContain('test-client-secret');
      expect(ready.text).not.toContain(process.env.MONGODB_URI ?? 'mongodb://');
    });
  });
});
