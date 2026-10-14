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

// Off, because these suites change what the fake upstream publishes between
// one sweep and the next — a ladder retired, a bracket index failing — to stand
// for changes that are really days apart. With the half-day cache on, the
// second sweep would be answered from the first. The cache has its own tests
// (`pvp.api.spec.ts`).
process.env.BLIZZARD_REFERENCE_CACHE_TTL_MS = '0';

// The same guard for the second upstream: a missed Raider.io seam must fail
// locally rather than spend the owner's real Raider.io allowance. The key is a
// placeholder for the same reason the Blizzard credentials are.
process.env.RAIDERIO_API_BASE_URL = 'http://127.0.0.1:9/raiderio';
process.env.RAIDER_IO_API_KEY = 'test-raiderio-key';
