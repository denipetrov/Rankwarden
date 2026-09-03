#!/usr/bin/env node
// Verifies the app can reach MongoDB and reports what has been ingested so far.
// Run with: npm run db:check
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const dbName = process.env.MONGODB_DB ?? 'rankwarden';
const COLLECTION = 'leaderboard_entries';

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });

try {
  await client.connect();
  const db = client.db(dbName);

  const { version } = await db.admin().serverStatus();
  console.log(`✓ Connected to MongoDB ${version} at ${uri} (database "${dbName}")\n`);

  const collections = await db.listCollections().toArray();
  if (collections.length === 0) {
    console.log('No collections yet — start the app to run the first sweep.');
    process.exit(0);
  }

  for (const { name } of collections) {
    console.log(`${name}: ${await db.collection(name).countDocuments()} documents`);
  }

  const entries = db.collection(COLLECTION);
  if (!collections.some((collection) => collection.name === COLLECTION)) {
    process.exit(0);
  }

  const indexes = await entries.indexes();
  console.log(`\nIndexes: ${indexes.map((index) => index.name).join(', ')}`);

  const breakdown = await entries
    .aggregate([
      {
        $group: {
          _id: { region: '$region', bracket: '$bracket' },
          entries: { $sum: 1 },
          topRating: { $max: '$rating' },
          lastFetchedAt: { $max: '$fetchedAt' },
        },
      },
      { $sort: { '_id.region': 1, '_id.bracket': 1 } },
    ])
    .toArray();

  if (breakdown.length > 0) {
    console.log('\nregion  bracket          entries  top rating  last sweep');
    for (const row of breakdown) {
      console.log(
        [
          row._id.region.padEnd(6),
          row._id.bracket.padEnd(16),
          String(row.entries).padStart(7),
          String(row.topRating).padStart(11),
          `  ${row.lastFetchedAt?.toISOString() ?? 'n/a'}`,
        ].join(' '),
      );
    }
  }
} catch (error) {
  console.error(`✗ Could not reach MongoDB at ${uri}`);
  console.error(`  ${error.message}`);
  console.error('\n  Is the container up? Try: npm run db:up');
  process.exitCode = 1;
} finally {
  await client.close();
}
