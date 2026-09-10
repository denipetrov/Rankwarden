import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Db } from 'mongodb';

import {
  ARCHIVE_BRACKETS_COLLECTION,
  ARCHIVE_ENTRIES_COLLECTION,
  ARCHIVE_SEASONS_COLLECTION,
} from '../src/archive/entities/archive.entity.js';
import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../src/leaderboard/entities/rating.entity.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { CHARACTER_INDEXES } from './support/invariants.js';
import { World } from './support/world.js';

/**
 * S1.10 / S5.14 — what a boot with the work switched off is allowed to do.
 *
 * Both switches are the ones anyone reaches for during an incident, so the
 * failure mode that matters is a job that ignores its own flag and spends quota
 * or writes data anyway. Index creation is the deliberate exception: it belongs
 * to `onModuleInit`, not to the sweep, and must happen regardless.
 */
describe('S1.10 / S5.14 — boot with ingestion and archiving disabled', () => {
  let harness: TestApp;
  let db: Db;
  let baseUrl: string;

  beforeAll(async () => {
    // No ENV at all: the harness defaults already have every job off, which is
    // the configuration under test.
    harness = await bootTestApp(World.seed({ regions: ['us', 'eu'], players: 40, seed: 110 }));
    db = harness.app.get(MongoService).db;
    baseUrl = await harness.listen();
    await harness.settle();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('S1.10 — creates every index and writes nothing else', async () => {
    const names = (await db.collection(CHARACTERS_COLLECTION).listIndexes().toArray())
      .map((index) => index.name)
      .sort();

    expect(names, 'indexes are onModuleInit work, not sweep work').toEqual(
      [...CHARACTER_INDEXES].sort(),
    );

    expect(await db.collection(CHARACTERS_COLLECTION).countDocuments()).toBe(0);
    for (const collection of Object.values(RATING_COLLECTIONS)) {
      expect(await db.collection(collection).countDocuments(), collection).toBe(0);
    }
  });

  it('S1.10b — and issues no leaderboard request', () => {
    expect(
      harness.blizzard.requests.filter((request) => request.path.includes('/pvp-leaderboard/')),
      'a disabled sweep must not cost a single request',
    ).toEqual([]);
  });

  it('S5.14 — the archive registers no interval and touches nothing', async () => {
    expect(
      harness.app.get(SchedulerRegistry).doesExist('interval', 'season-archive'),
      'a disabled archive registers no interval to be woken by',
    ).toBe(false);

    for (const collection of [
      ARCHIVE_ENTRIES_COLLECTION,
      ARCHIVE_SEASONS_COLLECTION,
      ARCHIVE_BRACKETS_COLLECTION,
    ]) {
      expect(await db.collection(collection).countDocuments(), collection).toBe(0);
    }
  });

  it('S5.14b — including on a season the backlog would otherwise have taken', () => {
    // The World seeds two finished seasons behind the live one, so a backfill
    // that ignored its flag would have something to reach for.
    expect(
      harness.blizzard.requests.filter((request) => /pvp-season\/(40|41)/.test(request.path)),
      'nothing went looking for history',
    ).toEqual([]);
  });

  it('S11.11 — both health endpoints answer before anything has ingested', async () => {
    // An empty cache must never be an exception. This is the state a fresh
    // deployment is in for its first few minutes, and it is exactly when
    // somebody is watching the probe.
    const live = await getJson<{
      status: string;
      sweepRunning: boolean;
      seasons: Record<string, unknown>;
      jobs: { lastSweep: unknown; warmedUp: boolean };
    }>(baseUrl, '/health');

    expect(live.status).toBe(200);
    expect(live.body.status).toBe('ok');
    expect(live.body.sweepRunning).toBe(false);
    expect(live.body.jobs.lastSweep, 'nothing has swept yet').toBeNull();
    expect(live.body.jobs.warmedUp).toBe(false);

    const ready = await getJson<{
      status: string;
      dependencies: { mongo: { status: string }; blizzard: { status: string } };
    }>(baseUrl, '/health/ready');

    expect(ready.status, 'the database is up, so it is ready').toBe(200);
    expect(ready.body.dependencies.mongo.status).toBe('ok');
    // Nothing has called Blizzard, so there is nothing observed to report —
    // which is not the same as it being down, and must not read as a failure.
    expect(ready.body.dependencies.blizzard.status).toBe('unknown');
  });

  it('S11.11b — and so does the season detail, with an empty cache', async () => {
    const seasons = await getJson<{
      seasons: Record<string, unknown>;
      transition: { permitted: boolean; reason: string | null };
    }>(baseUrl, '/health/seasons');

    expect(seasons.status).toBe(200);
    expect(Object.keys(seasons.body.seasons), 'season refresh is off in this boot').toEqual([]);
    // No region observed means the purge abstains rather than guessing, and it
    // says which regions it is waiting on.
    expect(seasons.body.transition.permitted).toBe(false);
    expect(seasons.body.transition.reason).toMatch(/not yet observed/);
  });
});
