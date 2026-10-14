import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import {
  ALL_COLLECTIONS,
  ARCHIVE_ENTRIES_COLLECTION,
  CHARACTERS_COLLECTION,
  MPLUS_SPEC_REPRESENTATION_COLLECTION,
  QUOTA_WINDOWS_COLLECTION,
} from '../src/database/collections.js';
import type { MongoService } from '../src/database/mongo.service.js';
import { DATABASE_SCHEMA } from '../src/database/schema/schema.definition.js';
import { SchemaService } from '../src/database/schema/schema.service.js';
import { openTestDatabase, testDbName } from './support/database.js';

/**
 * The schema step and the check the service runs against it, on a real
 * database and without the application around them.
 *
 * `apply` is what the deploy runs; `verify` is what production runs at every
 * start. The second is only worth having if it notices each way a database can
 * be wrong, so most of this file breaks the structure on purpose, one way at a
 * time, and reads what `verify` says about it.
 */
describe('database schema', () => {
  let db: Db;
  let drop: () => Promise<void>;
  let schema: SchemaService;

  const indexNames = async (collection: string) =>
    (await db.collection(collection).indexes()).map((index) => index.name);

  beforeAll(async () => {
    const opened = await openTestDatabase(testDbName(expect.getState().testPath));
    ({ db, drop } = opened);
    schema = new SchemaService({ db } as unknown as MongoService);
  });

  afterAll(async () => {
    await drop?.();
  });

  it('reports every collection missing on an empty database', async () => {
    const problems = await schema.verify();

    expect(problems).toHaveLength(ALL_COLLECTIONS.length);
    expect(problems).toContain(`collection "${CHARACTERS_COLLECTION}" does not exist`);
  });

  it('does not change the database by verifying it', async () => {
    expect(await db.listCollections().toArray()).toEqual([]);
  });

  it('builds every collection and index, after which nothing is reported', async () => {
    const report = await schema.apply();

    expect(report.collectionsCreated.sort()).toEqual([...ALL_COLLECTIONS].sort());
    expect(report.indexes).toBe(
      DATABASE_SCHEMA.reduce((total, definition) => total + definition.indexes.length, 0),
    );
    expect(await schema.verify()).toEqual([]);
  });

  it('creates a collection that has no index of its own', async () => {
    // With no index to build, nothing else in `apply` would bring it into being.
    const names = (await db.listCollections().toArray()).map((collection) => collection.name);

    expect(names).toContain(QUOTA_WINDOWS_COLLECTION);
  });

  it('is a no-op the second time', async () => {
    const report = await schema.apply();

    expect(report.collectionsCreated).toEqual([]);
    expect(report.retiredIndexesDropped).toEqual([]);
    expect(await schema.verify()).toEqual([]);
  });

  describe('verify notices', () => {
    it('a missing index', async () => {
      await db.collection(ARCHIVE_ENTRIES_COLLECTION).dropIndex('archive_board');

      expect(await schema.verify()).toEqual([
        `index "archive_board" on "${ARCHIVE_ENTRIES_COLLECTION}" is missing`,
      ]);

      await schema.apply();
    });

    it('an index of the right name over the wrong fields', async () => {
      // The case a name-only check would wave through.
      const collection = db.collection(ARCHIVE_ENTRIES_COLLECTION);
      await collection.dropIndex('archive_character');
      await collection.createIndex({ characterId: 1 }, { name: 'archive_character' });

      expect(await schema.verify()).toEqual([
        `index "archive_character" on "${ARCHIVE_ENTRIES_COLLECTION}" has key ` +
          '{"characterId":1}, declared as {"characterId":1,"seasonId":-1}',
      ]);

      await collection.dropIndex('archive_character');
      await schema.apply();
    });

    it('a unique index that is not unique', async () => {
      // Without uniqueness nothing fails: duplicates are simply written.
      const collection = db.collection(CHARACTERS_COLLECTION);
      await collection.dropIndex('character_identity');
      await collection.createIndex(
        { seasonId: 1, region: 1, characterId: 1 },
        { name: 'character_identity' },
      );

      expect(await schema.verify()).toEqual([
        `index "character_identity" on "${CHARACTERS_COLLECTION}" is not unique, declared unique`,
      ]);

      await collection.dropIndex('character_identity');
      await schema.apply();
    });

    it('a missing collection', async () => {
      await db.collection(QUOTA_WINDOWS_COLLECTION).drop();

      expect(await schema.verify()).toEqual([
        `collection "${QUOTA_WINDOWS_COLLECTION}" does not exist`,
      ]);

      await schema.apply();
    });

    it('a retired index still in place, by name and by pattern', async () => {
      const characters = db.collection(CHARACTERS_COLLECTION);
      await characters.createIndex({ specsFetchedAt: 1 }, { name: 'specs_staleness' });
      await characters.createIndex({ 'brackets.3v3.rank': 1 }, { name: 'bracket_3v3_rank' });
      await db
        .collection(MPLUS_SPEC_REPRESENTATION_COLLECTION)
        .createIndex({ season: 1, region: 1 }, { name: 'mplus_representation_identity' });

      expect((await schema.verify()).sort()).toEqual(
        [
          `retired index "specs_staleness" on "${CHARACTERS_COLLECTION}" has not been dropped`,
          `retired index "bracket_3v3_rank" on "${CHARACTERS_COLLECTION}" has not been dropped`,
          `retired index "mplus_representation_identity" on ` +
            `"${MPLUS_SPEC_REPRESENTATION_COLLECTION}" has not been dropped`,
        ].sort(),
      );
    });

    it('and apply drops them, leaving the declared ones alone', async () => {
      const report = await schema.apply();

      expect(report.retiredIndexesDropped.sort()).toEqual(
        [
          `${CHARACTERS_COLLECTION}.specs_staleness`,
          `${CHARACTERS_COLLECTION}.bracket_3v3_rank`,
          `${MPLUS_SPEC_REPRESENTATION_COLLECTION}.mplus_representation_identity`,
        ].sort(),
      );
      expect(await indexNames(CHARACTERS_COLLECTION)).toContain('bracket_ratings');
      expect(await schema.verify()).toEqual([]);
    });
  });

  it('leaves alone an index nobody declared', async () => {
    // An operator may add one to chase a slow query. That must neither stop the
    // service from starting nor be removed by the next release.
    const collection = db.collection(ARCHIVE_ENTRIES_COLLECTION);
    await collection.createIndex({ realmSlug: 1 }, { name: 'operator_added' });

    expect(await schema.verify()).toEqual([]);
    await schema.apply();
    expect(await indexNames(ARCHIVE_ENTRIES_COLLECTION)).toContain('operator_added');
  });
});
