import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MongoService } from '../src/database/mongo.service.js';
import { SeasonService } from '../src/season/season.service.js';
import { SEASON_STATE_COLLECTION } from '../src/season/entities/season-state.entity.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { World } from './support/world.js';

/**
 * The season refresh is enabled here, which is why this is its own file: a test
 * file locks in one configuration on its first boot.
 *
 * What it proves is the seam the whole integration suite rests on. Bootstrap
 * work is fire-and-forget in production — `onApplicationBootstrap` cannot await
 * anything — so without `whenSettled()` a test either polls for `season_state`
 * or races it, and closing the app mid-query shuts MongoDB down underneath a
 * live read.
 */
describe('bootstrap work is awaitable', () => {
  let harness: TestApp;

  beforeAll(async () => {
    harness = await bootTestApp(World.seed({ regions: ['us', 'eu'], players: 20, seed: 3 }), {
      SEASON_REFRESH_ENABLED: 'true',
    });
  });

  afterAll(async () => {
    await harness?.app.get(MongoService).db.dropDatabase();
    await harness?.close();
  });

  it('has persisted every region once the schedulers settle', async () => {
    await harness.settle();

    const state = await harness.app
      .get(MongoService)
      .db.collection(SEASON_STATE_COLLECTION)
      .find({})
      .sort({ region: 1 })
      .toArray();

    expect(state.map((entry) => entry.region)).toEqual(['eu', 'us']);
    expect(state[0]).toMatchObject({ seasonId: 42, endsAt: null });
  });

  it('has the season cached in memory too, without polling for it', () => {
    const seasons = harness.app.get(SeasonService);

    expect(seasons.getCurrentSeason('us')).toBe(42);
    expect(seasons.getCurrentSeason('eu')).toBe(42);
  });

  it('settles again immediately when nothing is in flight', async () => {
    const startedAt = Date.now();
    await harness.settle();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('refuses a second boot that asks for different configuration', async () => {
    // The quiet failure this guard exists to prevent: ESM caches the module
    // graph per file, so the second boot would reuse the first config.
    await expect(
      bootTestApp(World.seed({ regions: ['us'], players: 5 }), {
        SEASON_REFRESH_ENABLED: 'false',
      }),
    ).rejects.toThrow(/already booted an app with different configuration/);
  });
});
