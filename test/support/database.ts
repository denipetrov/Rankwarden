import { MongoClient, type Db } from 'mongodb';

/**
 * Every test database must carry this prefix.
 *
 * `ConfigModule` reads `.env.local` and `.env`, so a test that boots `AppModule`
 * without fully overriding the config inherits `MONGODB_DB=rankwarden` — the
 * real development database — and a sweep writes into it. The purge is safe
 * (dry run by default) but ingestion is not, so the name is checked rather than
 * assumed, everywhere a connection is opened.
 */
export const TEST_DB_PREFIX = 'rankwarden_test_';

export function testMongoUri(): string {
  return process.env.TEST_MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
}

/**
 * A database name unique to one test file, derived from its path.
 *
 * Per file rather than per run, so Vitest keeps its file-level parallelism
 * without two suites sharing collections.
 */
export function testDbName(testPath: string | undefined): string {
  const base = (testPath ?? `anon_${process.pid}`)
    .replaceAll('\\', '/')
    .split('/')
    .pop()!
    .replace(/\.spec\.ts$/, '')
    .replace(/[^a-z0-9]+/gi, '_')
    .toLowerCase();

  return `${TEST_DB_PREFIX}${base}`.slice(0, 60);
}

/** Refuses any database name that is not obviously a test one. */
export function assertTestDatabase(name: string): string {
  if (!name.startsWith(TEST_DB_PREFIX)) {
    throw new Error(
      `Refusing to run against database "${name}": test databases must start with ` +
        `"${TEST_DB_PREFIX}". This guard exists because ConfigModule falls back to ` +
        `.env, where MONGODB_DB is the real development database.`,
    );
  }

  return name;
}

/**
 * Opens a client against one test database, and hands back a disposer that
 * drops it. Used by the harness and by tests that need to seed or inspect
 * collections directly.
 */
export async function openTestDatabase(name: string): Promise<{
  client: MongoClient;
  db: Db;
  drop: () => Promise<void>;
}> {
  assertTestDatabase(name);
  const client = new MongoClient(testMongoUri());
  await client.connect();
  const db = client.db(name);

  return {
    client,
    db,
    drop: async () => {
      await db.dropDatabase();
      await client.close();
    },
  };
}
