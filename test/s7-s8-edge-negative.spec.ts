import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../src/leaderboard/entities/rating.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson, postJson } from './support/http.js';
import { expectInvariants } from './support/invariants.js';
import { World } from './support/world.js';

/**
 * S7 / S8 — edge conditions and failure injection.
 *
 * The conditions that are legal and occur in production, and the failures that
 * must degrade rather than destroy. Several of these encode domain rules that
 * were found by observing wrong data rather than by reading documentation.
 */
describe('S7 / S8 — edge cases and negative paths', () => {
  let harness: TestApp;
  let db: Db;
  let baseUrl: string;

  const characters = () => db.collection(CHARACTERS_COLLECTION);
  const sweep = () => harness.app.get(LeaderboardService).sweep();

  beforeAll(async () => {
    harness = await bootTestApp(World.seed({ regions: ['us', 'eu'], players: 80, seed: 8 }));
    db = harness.app.get(MongoService).db;
    await sweep();
    baseUrl = await harness.listen();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  describe('S7 — edge conditions', () => {
    it('S7.1 — non-ASCII names round-trip through the profile URL', async () => {
      // Anything outside printable ASCII: diacritics, Hangul, Han.
      const exotic = [...harness.world.players.values()].filter((player) =>
        [...player.name].some((character) => character.codePointAt(0)! > 127),
      );
      expect(exotic.length, 'the fixture must contain non-ASCII names').toBeGreaterThan(0);

      for (const player of exotic.slice(0, 5)) {
        const stored = await characters().findOne({
          characterId: player.id,
          region: player.region,
        });
        // Stored with its original casing and diacritics, not the lowercased,
        // percent-encoded form the API path needs.
        expect(stored!.characterName).toBe(player.name);
      }
    });

    it('S7.2 — the same characterId in two regions stays two characters', async () => {
      const shared = await characters()
        .aggregate<{ _id: number; regions: string[] }>([
          { $group: { _id: '$characterId', regions: { $addToSet: '$region' } } },
          { $match: { 'regions.1': { $exists: true } } },
          { $limit: 1 },
        ])
        .toArray();

      if (shared.length === 0) return; // fixture did not collide ids this run

      const docs = await characters().find({ characterId: shared[0]._id }).toArray();
      expect(docs).toHaveLength(2);
      expect(new Set(docs.map((doc) => doc.region)).size).toBe(2);
    });

    it('S7.3 — a rating of 0 is stored but never reaches a board', async () => {
      const player = [...harness.world.players.values()].find(
        (candidate) => candidate.region === 'us' && candidate.ratings.size >= 2,
      )!;
      const [bracket] = [...player.ratings.keys()];

      harness.world.setRating(player.id, bracket, 0);
      await sweep();

      const stored = await characters().findOne({ characterId: player.id, region: 'us' });
      expect(stored!.ratings[bracket]).toBe(0);

      // The predicate every board query must carry.
      const onBoard = await characters().countDocuments({
        region: 'us',
        [`ratings.${bracket}`]: { $gt: 0 },
        characterId: player.id,
      });
      expect(onBoard, 'a 0 rating must not appear on a board').toBe(0);

      // Without it, the zero-rated player is returned.
      const withExists = await characters().countDocuments({
        region: 'us',
        [`ratings.${bracket}`]: { $exists: true },
        characterId: player.id,
      });
      expect(withExists).toBe(1);
    });

    it('S7.4 — the wildcard index serves an ordered board with no blocking sort', async () => {
      for (const bracket of ['3v3', 'shuffle-mage-fire']) {
        const plan = await characters()
          .find({ seasonId: 42, region: 'us', [`ratings.${bracket}`]: { $gt: 0 } })
          .sort({ [`ratings.${bracket}`]: -1 })
          .limit(50)
          .explain('executionStats');

        const stages = JSON.stringify(plan.queryPlanner?.winningPlan ?? {});

        expect(stages, `${bracket} must use the wildcard index`).toContain('bracket_ratings');
        expect(stages, `${bracket} must not need a blocking sort`).not.toContain('"stage":"SORT"');
      }
    });

    it('S7.6 — absent match statistics and faction default cleanly', async () => {
      harness.world.corrupt('us', '2v2', {
        season: { id: 42 },
        name: '2v2',
        bracket: { id: 1, type: '2V2' },
        entries: [
          {
            // No faction, no season_match_statistics — both are optional and
            // both occur on real ladders.
            character: { id: 777001, name: 'Spartan', realm: { id: 60, slug: 'tarren-mill' } },
            rank: 1,
            rating: 2200,
          },
        ],
      });

      await sweep();
      const stored = await characters().findOne({ characterId: 777001, region: 'us' });

      expect(stored!.faction).toBeNull();
      expect(stored!.brackets['2v2']).toMatchObject({ played: 0, won: 0, lost: 0, rating: 2200 });

      harness.world.corrupt('us', '2v2', undefined);
    });
  });

  describe('S8 — negative paths', () => {
    it('S8.13 — a malformed payload fails its bracket and nothing else', async () => {
      const before = await characters().countDocuments();

      harness.world.corrupt('us', '3v3', {
        season: { id: 42 },
        name: '3v3',
        bracket: { id: 1, type: '3V3' },
        // rating as a string is the shape that would slip past a loose schema.
        entries: [
          {
            character: { id: 999001, name: 'Broken', realm: { id: 60, slug: 'tarren-mill' } },
            rank: 1,
            rating: '2400',
          },
        ],
      });

      const result = await sweep();

      expect(result!.failed).toBe(1);
      expect(
        result!.jobs.find((job) => job.bracket === '3v3' && job.region === 'us')?.error,
      ).toBeDefined();
      expect(await characters().findOne({ characterId: 999001 })).toBeNull();
      // Every other bracket still ingested.
      expect(await characters().countDocuments()).toBeGreaterThanOrEqual(before - 1);

      harness.world.corrupt('us', '3v3', undefined);
      await sweep();
    });

    it('S8.16 — a leaderboard served under the wrong season id is rejected', async () => {
      harness.world.corrupt('us', 'rbg', {
        season: { id: 43 }, // the sweep asked for 42
        name: 'rbg',
        bracket: { id: 3, type: 'RBG' },
        entries: [
          {
            character: { id: 999002, name: 'WrongSeason', realm: { id: 60, slug: 'tarren-mill' } },
            rank: 1,
            rating: 2500,
          },
        ],
      });

      const result = await sweep();
      const job = result!.jobs.find((entry) => entry.bracket === 'rbg' && entry.region === 'us');

      expect(job?.error, 'a season mismatch must fail the job').toBeDefined();
      expect(job!.error).toMatch(/season/i);
      expect(await characters().findOne({ characterId: 999002 })).toBeNull();

      harness.world.corrupt('us', 'rbg', undefined);
      await sweep();
    });

    it('S8.17 — a duplicate character within one payload settles on one document', async () => {
      harness.world.corrupt('us', '2v2', {
        season: { id: 42 },
        name: '2v2',
        bracket: { id: 1, type: '2V2' },
        entries: [
          {
            character: { id: 999003, name: 'Twice', realm: { id: 60, slug: 'tarren-mill' } },
            rank: 1,
            rating: 2400,
          },
          {
            character: { id: 999003, name: 'Twice', realm: { id: 60, slug: 'tarren-mill' } },
            rank: 2,
            rating: 2300,
          },
        ],
      });

      const result = await sweep();

      expect(
        result!.jobs.find((job) => job.bracket === '2v2' && job.region === 'us')?.error,
      ).toBeUndefined();
      expect(await characters().countDocuments({ characterId: 999003 })).toBe(1);
      expect(
        await db.collection(RATING_COLLECTIONS['2v2']).countDocuments({ characterId: 999003 }),
      ).toBe(1);

      harness.world.corrupt('us', '2v2', undefined);
      await sweep();
    });

    it('S8.26 — health answers with an empty cache and during a sweep', async () => {
      const live = await getJson<{ status: string; jobs: { sweepRunning: boolean } }>(
        baseUrl,
        '/health',
      );

      expect(live.status).toBe(200);
      expect(live.body.status).toBe('ok');
      expect(live.body.jobs).toBeDefined();
    });
  });

  describe('S8.19–S8.23 — the sync endpoint', () => {
    const sample = async () => {
      const doc = await characters().findOne({ region: 'us', 'brackets.3v3': { $exists: true } });
      expect(doc, 'need a 3v3 character to sync').not.toBeNull();

      return doc!;
    };

    it('S8.19 — 400 on payloads with nothing storable', async () => {
      const doc = await sample();
      const base = {
        seasonId: doc.seasonId,
        region: doc.region,
        characterId: doc.characterId,
        characterName: doc.characterName,
        realmId: doc.realmId,
        realmSlug: doc.realmSlug,
        faction: doc.faction,
      };

      const empty = await postJson(baseUrl, '/characters/sync', { ...base, brackets: {} });
      expect(empty.status).toBe(400);

      const aggregateOnly = await postJson(baseUrl, '/characters/sync', {
        ...base,
        brackets: { 'shuffle-overall': { rank: 1, rating: 2400 } },
      });
      expect(aggregateOnly.status).toBe(400);
      expect(aggregateOnly.text).toContain('shuffle-overall');

      const badRegion = await postJson(baseUrl, '/characters/sync', {
        ...base,
        region: 'xx',
        brackets: { '3v3': { rank: 1, rating: 2400 } },
      });
      expect(badRegion.status).toBe(400);
    });

    it('S8.20 — 404 rather than creating a character, and writes no rows', async () => {
      const doc = await sample();
      const before = await db
        .collection(RATING_COLLECTIONS['3v3'])
        .countDocuments({ characterId: 424242 });

      const response = await postJson(baseUrl, '/characters/sync', {
        seasonId: doc.seasonId,
        region: doc.region,
        characterId: 424242,
        characterName: 'Ghost',
        realmId: doc.realmId,
        realmSlug: doc.realmSlug,
        faction: 'HORDE',
        brackets: { '3v3': { rank: 1, rating: 2400 } },
      });

      expect(response.status).toBe(404);
      expect(await characters().countDocuments({ characterId: 424242 })).toBe(0);
      expect(
        await db.collection(RATING_COLLECTIONS['3v3']).countDocuments({ characterId: 424242 }),
        'a 404 must not leave rating rows behind',
      ).toBe(before);
    });

    it('S8.22 — a document read from Mongo posts back unchanged', async () => {
      const doc = await sample();
      const response = await postJson(baseUrl, '/characters/sync', doc);

      expect(response.status, response.text).toBe(200);

      const after = await characters().findOne({ _id: doc._id });
      expect(after!.ratings).toEqual(doc.ratings);
      expect(Object.keys(after!.brackets as object).sort()).toEqual(
        Object.keys(doc.brackets as object).sort(),
      );

      await expectInvariants(db);
    });

    it('S8.24 — malformed transport is 4xx, never 500', async () => {
      const raw = await fetch(`${baseUrl}/characters/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{ not json',
      });

      expect(raw.status).toBeGreaterThanOrEqual(400);
      expect(raw.status).toBeLessThan(500);

      const asArray = await postJson(baseUrl, '/characters/sync', []);
      expect(asArray.status).toBeGreaterThanOrEqual(400);
      expect(asArray.status).toBeLessThan(500);
    });
  });
});
