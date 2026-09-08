import { assertTestDatabase, testDbName, testMongoUri } from '../support/database.js';

/**
 * Runs before any test module is imported, so `ConfigModule.forRoot()` — which
 * reads `.env.local` and `.env` the moment `app.module.ts` is imported — never
 * sees the developer's own configuration.
 *
 * The database name is the part that matters. Without this, a test that boots
 * `AppModule` inherits `MONGODB_DB=rankwarden` from `.env` and a sweep writes
 * into the real development database. `assertTestDatabase` makes that a loud
 * failure rather than a silent one.
 */
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = testMongoUri();
process.env.MONGODB_DB = assertTestDatabase(testDbName(process.env.VITEST_TEST_PATH));

// Credentials are never used — the token provider is replaced at the seam — but
// the schema requires them, and a real value must never leak in from .env.
process.env.BLIZZARD_CLIENT_ID = 'test-client-id';
process.env.BLIZZARD_CLIENT_SECRET = 'test-client-secret';

// Nothing here should ever reach api.blizzard.com. If a test forgets to
// override the HTTP seam, this makes the attempt fail fast and locally instead
// of quietly consuming real quota.
process.env.BLIZZARD_API_HOST_TEMPLATE = 'http://127.0.0.1:9/{region}';
