#!/usr/bin/env node
// Verifies the app can reach MongoDB and reports what has been ingested so far.
// Run with: npm run db:check
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI ?? 'mongodb://localhost:27017';
const dbName = process.env.MONGODB_DB ?? 'rankwarden';
const COLLECTION = 'characters';
const CORE_BRACKETS = ['2v2', '3v3', 'rbg'];

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

  const spread = await entries
    .aggregate([
      { $project: { count: { $size: { $objectToArray: '$brackets' } } } },
      { $group: { _id: '$count', characters: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  if (spread.length > 0) {
    console.log(
      `
Characters by bracket count: ${spread.map((row) => `${row._id}× ${row.characters}`).join('  ')}`,
    );
  }

  const enriched = await entries.countDocuments({ profileStatus: 'ok' });
  const missing = await entries.countDocuments({ profileStatus: 'missing' });
  const pending = await entries.countDocuments({ profileFetchedAt: { $exists: false } });
  console.log(
    `
Profiles: ${enriched} enriched, ${missing} missing, ${pending} pending enrichment`,
  );

  if (enriched > 0) {
    const top = await entries
      .aggregate([
        { $match: { 'profile.heroTalentTree': { $ne: null } } },
        {
          $group: {
            _id: { cls: '$profile.class.name', hero: '$profile.heroTalentTree.name' },
            n: { $sum: 1 },
          },
        },
        { $sort: { n: -1 } },
        { $limit: 5 },
      ])
      .toArray();
    if (top.length > 0) {
      console.log(
        `Top hero talents: ${top.map((r) => `${r._id.cls}/${r._id.hero} (${r.n})`).join(', ')}`,
      );
    }
  }

  const breakdown = await entries
    .aggregate([
      { $project: { region: 1, brackets: { $objectToArray: '$brackets' } } },
      { $unwind: '$brackets' },
      {
        $group: {
          _id: { region: '$region', bracket: '$brackets.k' },
          entries: { $sum: 1 },
          topRating: { $max: '$brackets.v.rating' },
          lastFetchedAt: { $max: '$brackets.v.fetchedAt' },
        },
      },
      { $sort: { '_id.region': 1, '_id.bracket': 1 } },
    ])
    .toArray();

  // 85 brackets x 4 regions is too much to print: show the core ladders in full
  // and roll the per-specialisation ones up per region.
  const isCore = (name) => CORE_BRACKETS.includes(name);
  const core = breakdown.filter((row) => isCore(row._id.bracket));

  if (core.length > 0) {
    console.log('\nregion  bracket          entries  top rating  last sweep');
  }
  for (const row of core) {
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

  const perRegion = new Map();
  for (const row of breakdown.filter((r) => !isCore(r._id.bracket))) {
    const acc = perRegion.get(row._id.region) ?? { brackets: 0, entries: 0 };
    acc.brackets += 1;
    acc.entries += row.entries;
    perRegion.set(row._id.region, acc);
  }
  if (perRegion.size > 0) {
    console.log('\nspecialisation ladders (shuffle-* / blitz-*):');
    for (const [region, acc] of [...perRegion].sort()) {
      console.log(`  ${region.padEnd(4)} ${acc.brackets} brackets, ${acc.entries} entries`);
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
