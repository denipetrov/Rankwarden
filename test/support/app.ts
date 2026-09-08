import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { expect } from 'vitest';

import { BLIZZARD_TOKEN_PROVIDER } from '../../src/blizzard/auth/token-provider.js';
import { BlizzardHttpService } from '../../src/blizzard/http/blizzard-http.service.js';
import { assertTestDatabase, testDbName, testMongoUri } from './database.js';
import { FakeBlizzard } from './fake-blizzard.js';
import type { World } from './world.js';

export interface TestApp {
  app: INestApplication;
  world: World;
  blizzard: FakeBlizzard;
  dbName: string;
  /** Resolves anything a scheduler started at bootstrap. */
  settle: () => Promise<void>;
  /** Base URL once `listen` has been called; throws before that. */
  url: () => string;
  listen: () => Promise<string>;
  close: () => Promise<void>;
}

/**
 * Environment every test app boots with. Intervals are pushed beyond the
 * lifetime of any test, and the startup sweep is off, so jobs are driven by
 * hand rather than raced against.
 */
const BASE_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'error',
  BLIZZARD_CLIENT_ID: 'test-client-id',
  BLIZZARD_CLIENT_SECRET: 'test-client-secret',
  INGEST_RUN_ON_STARTUP: 'false',
  INGEST_INTERVAL_MS: '3600000',
  PROFILE_INTERVAL_MS: '3600000',
  ARCHIVE_CHECK_INTERVAL_MS: '3600000',
  REPRESENTATION_CHECK_INTERVAL_MS: '3600000',
  SEASON_REFRESH_INTERVAL_MS: '3600000',
  SEASON_TRANSITION_CHECK_INTERVAL_MS: '3600000',
  // Every background job off unless a test asks for it. Each can be re-enabled
  // through `env`, which is how the scheduler-wiring cases turn one back on.
  PROFILE_ENRICHMENT_ENABLED: 'false',
  REPRESENTATION_ENABLED: 'false',
  ARCHIVE_ENABLED: 'false',
  SEASON_REFRESH_ENABLED: 'false',
  SEASON_TRANSITION_ENABLED: 'false',
};

/** The configuration the first boot in this file locked in. */
let bootedConfig: Record<string, string> | null = null;

/**
 * Refuses a second boot in the same file that asks for different configuration.
 *
 * `ConfigModule.forRoot()` reads the environment when `app.module.ts` is first
 * imported, and ESM caches that module for the lifetime of the test file — so a
 * later boot silently inherits the first boot's configuration instead of its
 * own. That failure is quiet and confusing: the app comes up, but against the
 * wrong database and the wrong regions, and the assertion that eventually fails
 * has nothing to do with the cause.
 *
 * Rebooting with identical configuration is fine and is what the restart cases
 * do, so only a difference is rejected. To boot with different configuration,
 * put it in its own test file.
 */
function assertConfigUnchanged(resolved: Record<string, string>): void {
  if (!bootedConfig) {
    bootedConfig = resolved;
    return;
  }

  const changed = Object.keys(resolved).filter((key) => bootedConfig![key] !== resolved[key]);
  if (changed.length === 0) return;

  throw new Error(
    `This file already booted an app with different configuration (${changed.join(', ')}). ` +
      'ConfigModule reads the environment once per module graph, and the graph is cached ' +
      'per test file, so the second boot would silently reuse the first configuration. ' +
      'Move this scenario into its own test file.',
  );
}

/** Clears the per-file configuration lock. Only for testing the harness itself. */
export function resetBootGuard(): void {
  bootedConfig = null;
}

/**
 * Boots the real `AppModule` against a real MongoDB and a fake Blizzard.
 *
 * Configuration is applied through `process.env` before `AppModule` is
 * imported, rather than by overriding `ConfigService`. `ConfigModule` is
 * registered with `isGlobal: true, cache: true` and reads its env files when
 * `forRoot()` runs — which happens while `app.module.ts` is being imported — so
 * an override handed to the testing module afterwards is racing a decision that
 * has already been made. Setting the environment first sidesteps the question
 * entirely. Vitest isolates the module graph per test file, so each file gets
 * its own `forRoot()` and therefore its own configuration.
 */
export async function bootTestApp(
  world: World,
  env: Record<string, string> = {},
): Promise<TestApp> {
  const dbName = assertTestDatabase(env.MONGODB_DB ?? testDbName(expect.getState().testPath));
  const resolved = {
    ...BASE_ENV,
    MONGODB_URI: testMongoUri(),
    BLIZZARD_REGIONS: world.regions.join(','),
    ...env,
    MONGODB_DB: dbName,
  };

  assertConfigUnchanged(resolved);

  for (const [key, value] of Object.entries(resolved)) {
    process.env[key] = value;
  }

  // Imported only now, so `ConfigModule.forRoot()` sees the environment above.
  const { AppModule } = await import('../../src/app.module.js');

  const blizzard = new FakeBlizzard(world);
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(BlizzardHttpService)
    .useValue(blizzard)
    .overrideProvider(BLIZZARD_TOKEN_PROVIDER)
    .useValue({ getAccessToken: async () => 'test-token', validateToken: async () => true })
    .compile();

  const app = moduleRef.createNestApplication();
  // Runs onModuleInit (indexes) and onApplicationBootstrap (schedulers).
  await app.init();

  let baseUrl: string | null = null;

  const settle = async () => {
    const { schedulerSeams } = await import('./seams.js');
    await Promise.all(schedulerSeams(app).map((seam) => seam.whenSettled()));
  };

  return {
    app,
    world,
    blizzard,
    dbName,
    settle,
    url: () => {
      if (!baseUrl) throw new Error('call listen() before url()');

      return baseUrl;
    },
    listen: async () => {
      await app.listen(0);
      baseUrl = (await app.getUrl()).replace('[::1]', '127.0.0.1');

      return baseUrl;
    },
    close: async () => {
      // Drain first: closing while a scheduler is mid-query shuts MongoDB down
      // underneath it, which surfaces as an intermittent "MongoClient must be
      // connected" that looks like a bug in the test.
      await settle();
      await app.close();
    },
  };
}
