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
    const dropped = await dropTestDatabases(client);

    if (dropped > 0) {
      console.log(`[test] dropped ${dropped} leftover test database(s)`);
    }
  } finally {
    await client.close();
  }
}

/**
 * Runs once after every file has finished: drops the run's own databases, so
 * a finished run leaves nothing behind. Not every file drops its database in
 * `afterAll` (restart cases need it to outlive a close), and without this
 * they stayed until the next run's `setup` — 26 of them, between runs.
 * Best effort: a MongoDB that went away mid-run must not fail a green run.
 */
export async function teardown(): Promise<void> {
  const client = new MongoClient(testMongoUri(), { serverSelectionTimeoutMS: 5_000 });

  try {
    await client.connect();
    await dropTestDatabases(client);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[test] could not drop the test databases after the run: ${reason}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Drops every `rankwarden_test_*` database, and only those. Returns how many. */
async function dropTestDatabases(client: MongoClient): Promise<number> {
  const { databases } = await client.db('admin').admin().listDatabases({ nameOnly: true });
  const names = databases
    .map((database) => database.name)
    .filter((name) => name.startsWith(TEST_DB_PREFIX));

  for (const name of names) {
    await client.db(name).dropDatabase();
  }

  return names.length;
}
