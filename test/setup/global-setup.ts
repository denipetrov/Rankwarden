import { MongoClient } from 'mongodb';

import { TEST_DB_PREFIX, testMongoUri } from '../support/database.js';

/**
 * Runs once per integration run, before any worker starts.
 *
 * Two jobs: fail with something readable when MongoDB is not up — the
 * alternative is every file timing out on connect and burying the cause — and
 * clear databases left behind by a run that was killed part-way.
 */
export async function setup(): Promise<void> {
  const uri = testMongoUri();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });

  try {
    await client.connect();
    await client.db('admin').command({ ping: 1 });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await client.close().catch(() => undefined);

    throw new Error(
      `Integration tests need MongoDB at ${uri}, which is not reachable (${reason}). ` +
        'Start it with "npm run db:up", or point TEST_MONGODB_URI elsewhere.',
      { cause: error },
    );
  }

  try {
    const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true });
    const leftovers = databases
      .map((database) => database.name)
      .filter((name) => name.startsWith(TEST_DB_PREFIX));

    for (const name of leftovers) {
      await client.db(name).dropDatabase();
    }

    if (leftovers.length > 0) {
      console.log(`[test] dropped ${leftovers.length} leftover test database(s)`);
    }
  } finally {
    await client.close();
  }
}
