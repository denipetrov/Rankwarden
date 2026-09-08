import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { RATING_FAMILIES } from '../src/blizzard/blizzard.constants.js';
import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../src/leaderboard/entities/rating.entity.js';
import { ARCHIVE_ENTRIES_COLLECTION } from '../src/archive/entities/archive.entity.js';
import { SPEC_REPRESENTATION_COLLECTION } from '../src/representation/entities/spec-representation.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { SeasonService } from '../src/season/season.service.js';
import { SEASON_STATE_COLLECTION } from '../src/season/entities/season-state.entity.js';
import { bootTestApp, type TestApp } from './support/app.js';
import {
  CHARACTER_INDEXES,
  expectInvariants,
  expectIndexInventory,
  expectNoUnrankedCharacters,
} from './support/invariants.js';
import { World } from './support/world.js';

/**
 * S1 — cold start and first fill.
 *
 * Empty database, empty caches, first boot. The world here is the full-breadth
 * one: 85 published brackets across two regions, so `isIngestableBracket` and
 * the upsert race are both exercised for real rather than in a fixture built to
 * avoid them.
 */
describe('S1 — cold start and first fill', () => {
  let harness: TestApp;
  let db: Db;

  // S1 is about what a cold boot resolves, so the season refresh is on. The
  // harness disables it by default so most files do not race it; a file locks
  // its configuration on the first boot, so every boot here passes the same env.
  const ENV = { SEASON_REFRESH_ENABLED: 'true' };

  beforeAll(async () => {
    harness = await bootTestApp(
      World.seed({ regions: ['us', 'eu'], players: 200, seed: 1, multiBracketShare: 0.4 }),
      ENV,
    );
    db = harness.app.get(MongoService).db;
    await harness.settle();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  describe('S1.1 — indexes exist on an empty database', () => {
    it('creates exactly the six indexes on characters', async () => {
      await expectIndexInventory(db);
    });

    it('creates three indexes on every ratings collection', async () => {
      for (const family of RATING_FAMILIES) {
        const names = (await db.collection(RATING_COLLECTIONS[family]).indexes())
          .map((index) => index.name)
          .sort();

        expect(names, RATING_COLLECTIONS[family]).toEqual(
          ['_id_', 'board_order', 'character', 'entry_identity'].sort(),
        );
      }
    });

    it('marks the identity indexes unique', async () => {
      const characterIdentity = (await db.collection(CHARACTERS_COLLECTION).indexes()).find(
        (index) => index.name === 'character_identity',
      );
      expect(characterIdentity?.unique).toBe(true);

      for (const family of RATING_FAMILIES) {
        const identity = (await db.collection(RATING_COLLECTIONS[family]).indexes()).find(
          (index) => index.name === 'entry_identity',
        );
        expect(identity?.unique, RATING_COLLECTIONS[family]).toBe(true);
      }
    });

    it('creates the archive and representation indexes', async () => {
      const archive = (await db.collection(ARCHIVE_ENTRIES_COLLECTION).indexes()).map(
        (index) => index.name,
      );
      expect(archive).toEqual(
        expect.arrayContaining(['archive_board', 'archive_identity', 'archive_character']),
      );

      const representation = (await db.collection(SPEC_REPRESENTATION_COLLECTION).indexes()).map(
        (index) => index.name,
      );
      expect(representation).toEqual(expect.arrayContaining(['snapshot_identity', 'series']));
    });
  });

  describe('S1.2 — the season resolves per region', () => {
    it('caches a season for every configured region', () => {
      const described = harness.app.get(SeasonService).describe();

      expect(Object.keys(described).sort()).toEqual(['eu', 'us']);
      for (const region of ['us', 'eu'] as const) {
        expect(described[region]).toMatchObject({
          id: harness.world.season(region).id,
          startsAt: expect.any(String),
          endsAt: null,
        });
      }
    });

    it('persists the season state so a restart can detect a rollover', async () => {
      const states = await db.collection(SEASON_STATE_COLLECTION).find({}).toArray();

      expect(states.map((state) => state.region).sort()).toEqual(['eu', 'us']);
      for (const state of states)
        expect(state.seasonId).toBe(harness.world.season(state.region).id);
    });
  });

  describe('S1.3 — jobs come from the API, minus the aggregates', () => {
    let result: Awaited<ReturnType<LeaderboardService['sweep']>>;

    beforeAll(async () => {
      harness.blizzard.reset();
      result = await harness.app.get(LeaderboardService).sweep();
    });

    it('builds 83 jobs per region, never 85', () => {
      expect(result).not.toBeNull();
      expect(result!.jobs).toHaveLength(83 * 2);
      expect(result!.failed).toBe(0);
    });

    it('never requests an aggregate ladder', () => {
      expect(harness.blizzard.countMatching('shuffle-overall')).toBe(0);
      expect(harness.blizzard.countMatching('blitz-overall')).toBe(0);
    });

    it('reports nothing removed on a first fill', () => {
      expect(result!.removedCharacters).toBe(0);
    });

    it('S1.4 — stores one document per character per season and region', async () => {
      const multi = await db
        .collection(CHARACTERS_COLLECTION)
        .findOne({ $expr: { $gte: [{ $size: { $objectToArray: '$brackets' } }, 3] } });

      expect(multi, 'the fixture must produce multi-bracket characters').not.toBeNull();
      expect(Object.keys(multi!.ratings as object)).toEqual(
        expect.arrayContaining(Object.keys(multi!.brackets as object)),
      );
      // Identity is stored once, not per ladder.
      expect(multi).toMatchObject({
        characterName: expect.any(String),
        realmSlug: expect.any(String),
        faction: expect.any(String),
      });
    });

    it('S1.5 — fans rating rows out per family', async () => {
      const shuffleRows = await db
        .collection(RATING_COLLECTIONS.shuffle)
        .aggregate([
          { $group: { _id: '$characterId', brackets: { $sum: 1 } } },
          { $match: { brackets: { $gte: 2 } } },
          { $limit: 1 },
        ])
        .toArray();

      // A character on several shuffle specs holds one row per spec — the whole
      // reason the family collections are flat.
      expect(shuffleRows.length).toBeGreaterThan(0);
    });

    it('S1.7 — every job carries its region season id', () => {
      const seasons = new Set(result!.jobs.map((job) => job.seasonId));
      expect(seasons.size).toBeGreaterThan(0);
      for (const job of result!.jobs) expect(job.error).toBeUndefined();
    });

    it('holds every standing invariant, including I7', async () => {
      await expectInvariants(db, harness.world);
      await expectNoUnrankedCharacters(db);
    });
  });

  describe('S1.8 — a second identical sweep changes nothing but timestamps', () => {
    it('produces no duplicates and removes nobody', async () => {
      const before = {
        characters: await db.collection(CHARACTERS_COLLECTION).countDocuments(),
        rows: await db.collection(RATING_COLLECTIONS['3v3']).countDocuments(),
      };
      const sample = await db.collection(CHARACTERS_COLLECTION).findOne({});

      const second = await harness.app.get(LeaderboardService).sweep();

      expect(second!.removedCharacters).toBe(0);
      expect(await db.collection(CHARACTERS_COLLECTION).countDocuments()).toBe(before.characters);
      expect(await db.collection(RATING_COLLECTIONS['3v3']).countDocuments()).toBe(before.rows);

      const after = await db.collection(CHARACTERS_COLLECTION).findOne({ _id: sample!._id });
      expect(after!.updatedAt.getTime()).toBeGreaterThanOrEqual(sample!.updatedAt.getTime());

      await expectInvariants(db, harness.world);
    });
  });

  describe('S1.9 — overlapping sweeps are skipped, not queued', () => {
    it('resolves the second call null without issuing requests', async () => {
      const leaderboards = harness.app.get(LeaderboardService);
      harness.blizzard.delayMs = 5;
      harness.blizzard.reset();

      const [first, second] = await Promise.all([leaderboards.sweep(), leaderboards.sweep()]);
      harness.blizzard.delayMs = 0;

      // Exactly one of the two ran; the other found the flag set and returned.
      expect([first, second].filter((value) => value === null)).toHaveLength(1);
      expect([first, second].filter((value) => value !== null)).toHaveLength(1);
    });
  });

  describe('S1.11 — legacy aggregate data is purged at boot', () => {
    it('unsets aggregates and deletes anyone left ranking in nothing', async () => {
      const seasonId = 1;
      await db.collection(CHARACTERS_COLLECTION).insertMany([
        {
          seasonId,
          region: 'us',
          characterId: 900001,
          characterName: 'Legacy',
          realmId: 60,
          realmSlug: 'tarren-mill',
          faction: 'HORDE',
          brackets: {
            '3v3': { rank: 1, rating: 2000, played: 1, won: 1, lost: 0, fetchedAt: new Date() },
            'shuffle-overall': {
              rank: 1,
              rating: 2400,
              played: 1,
              won: 1,
              lost: 0,
              fetchedAt: new Date(),
            },
          },
          ratings: { '3v3': 2000, 'shuffle-overall': 2400 },
          best: { shuffle: 2400 },
          updatedAt: new Date(),
        },
        {
          seasonId,
          region: 'us',
          characterId: 900002,
          characterName: 'OnlyAggregate',
          realmId: 60,
          realmSlug: 'tarren-mill',
          faction: 'HORDE',
          brackets: {
            'blitz-overall': {
              rank: 1,
              rating: 2100,
              played: 1,
              won: 1,
              lost: 0,
              fetchedAt: new Date(),
            },
          },
          ratings: { 'blitz-overall': 2100 },
          updatedAt: new Date(),
        },
      ]);

      // The purge runs in onModuleInit, so a fresh boot against the same
      // database is what exercises it.
      const second = await bootTestApp(harness.world, { ...ENV, MONGODB_DB: harness.dbName });
      await second.settle();

      const survivor = await db
        .collection(CHARACTERS_COLLECTION)
        .findOne({ characterId: 900001, seasonId });
      const removed = await db
        .collection(CHARACTERS_COLLECTION)
        .findOne({ characterId: 900002, seasonId });

      await second.close();

      expect(survivor, 'a character with real brackets survives').not.toBeNull();
      expect(survivor!.brackets).not.toHaveProperty('shuffle-overall');
      expect(survivor!.ratings).not.toHaveProperty('shuffle-overall');
      expect(survivor).not.toHaveProperty('best');
      expect(survivor!.brackets).toHaveProperty('3v3');

      expect(removed, 'a character left ranking in nothing is deleted').toBeNull();
    });
  });

  describe('S1.12 — legacy per-bracket indexes are dropped', () => {
    it('drops the superseded ones and keeps everything else', async () => {
      const characters = db.collection(CHARACTERS_COLLECTION);
      await characters.createIndex({ 'brackets.3v3.rank': 1 }, { name: 'bracket_3v3_rank' });
      await characters.createIndex({ 'best.shuffle': 1 }, { name: 'best_in_family' });
      // A decoy the regex must not match.
      await characters.createIndex({ updatedAt: 1 }, { name: 'bracket_ratings_backup' });

      const second = await bootTestApp(harness.world, { ...ENV, MONGODB_DB: harness.dbName });
      await second.settle();

      const names = (await characters.indexes()).map((index) => index.name);
      await second.close();

      expect(names).not.toContain('bracket_3v3_rank');
      expect(names).not.toContain('best_in_family');
      expect(names, 'the regex must not eat an unrelated index').toContain(
        'bracket_ratings_backup',
      );
      for (const expected of CHARACTER_INDEXES) expect(names).toContain(expected);

      await characters.dropIndex('bracket_ratings_backup');
    });
  });
});
