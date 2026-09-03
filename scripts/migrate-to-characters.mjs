#!/usr/bin/env node
// One-off migration: folds the flat `leaderboard_entries` collection into the
// grouped `characters` shape (one document per character, brackets nested).
//
// Additive and re-runnable — it only writes to `characters` and never touches
// the source collection. Drop the old one yourself once you are satisfied:
//   npm run db:shell  ->  db.leaderboard_entries.drop()
//
// Run with: npm run db:migrate
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const dbName = process.env.MONGODB_DB ?? 'rankwarden';
const SOURCE = 'leaderboard_entries';
const TARGET = 'characters';

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });

try {
  await client.connect();
  const db = client.db(dbName);

  const collections = await db.listCollections({ name: SOURCE }).toArray();
  if (collections.length === 0) {
    console.log(`Nothing to migrate: "${SOURCE}" does not exist.`);
    process.exit(0);
  }

  const source = db.collection(SOURCE);
  const target = db.collection(TARGET);

  const entries = await source.countDocuments();
  console.log(`Reading ${entries} entries from "${SOURCE}"…`);

  // $merge matches on these fields, so the unique index has to exist first.
  await target.createIndex(
    { seasonId: 1, region: 1, characterId: 1 },
    { name: 'character_identity', unique: true },
  );

  await source
    .aggregate(
      [
        {
          $group: {
            _id: { seasonId: '$seasonId', region: '$region', characterId: '$characterId' },
            characterName: { $last: '$characterName' },
            realmId: { $last: '$realmId' },
            realmSlug: { $last: '$realmSlug' },
            faction: { $last: '$faction' },
            updatedAt: { $max: '$fetchedAt' },
            brackets: {
              $push: {
                k: '$bracket',
                v: {
                  rank: '$rank',
                  rating: '$rating',
                  played: '$played',
                  won: '$won',
                  lost: '$lost',
                  fetchedAt: '$fetchedAt',
                },
              },
            },
          },
        },
        {
          $project: {
            _id: 0,
            seasonId: '$_id.seasonId',
            region: '$_id.region',
            characterId: '$_id.characterId',
            characterName: 1,
            realmId: 1,
            realmSlug: 1,
            faction: 1,
            updatedAt: 1,
            brackets: { $arrayToObject: '$brackets' },
          },
        },
        {
          $merge: {
            into: TARGET,
            on: ['seasonId', 'region', 'characterId'],
            whenMatched: 'merge',
            whenNotMatched: 'insert',
          },
        },
      ],
      { allowDiskUse: true },
    )
    .toArray();

  const characters = await target.countDocuments();
  console.log(`✓ Wrote ${characters} characters to "${TARGET}"`);
  console.log(`  ${entries} entries collapsed into ${characters} documents`);
  console.log(`\n  "${SOURCE}" is untouched — drop it once you have checked the result.`);
} catch (error) {
  console.error(`✗ Migration failed against ${uri}`);
  console.error(`  ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.close();
}
