import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoggerService } from '@nestjs/common';
import type { Db } from 'mongodb';

import { ARCHIVE_SEASONS_COLLECTION } from '../src/archive/entities/archive.entity.js';
import { SPEC_REPRESENTATION_COLLECTION } from '../src/representation/entities/spec-representation.entity.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { AGGREGATE_BRACKETS, CORE_BRACKETS, World } from './support/world.js';

const SEASON = 42;
const OLDER = 41;

/** Collects bootstrap logging, which `app.useLogger` is far too late to see. */
class CapturingLogger implements LoggerService {
  readonly lines: { level: string; message: string }[] = [];

  private push(level: string, message: unknown) {
    this.lines.push({ level, message: typeof message === 'string' ? message : String(message) });
  }

  log = (m: unknown) => this.push('log', m);
  error = (m: unknown) => this.push('error', m);
  warn = (m: unknown) => this.push('warn', m);
  debug = (m: unknown) => this.push('debug', m);
  verbose = (m: unknown) => this.push('verbose', m);

  matching(pattern: RegExp) {
    return this.lines.filter((line) => pattern.test(line.message));
  }
}

/**
 * S1.13 / S5.1 — the order background jobs start in on a cold boot.
 *
 * This is the one moment where every job in the service wants the same quota at
 * once, and the priority order — sweep, then enrichment, then the snapshot, and
 * only then the archive — exists entirely to stop the backfill competing with
 * the live fill. Nothing had ever asserted it end to end.
 *
 * Its own file because it is the only one that boots with the startup sweep and
 * every job switched on, and because the logger has to be installed before
 * `app.init()` rather than after it.
 */
describe('S1.13 / S5.1 — bootstrap ordering', () => {
  const ENV = {
    INGEST_RUN_ON_STARTUP: 'true',
    SEASON_REFRESH_ENABLED: 'true',
    PROFILE_ENRICHMENT_ENABLED: 'true',
    REPRESENTATION_ENABLED: 'true',
    ARCHIVE_ENABLED: 'true',
    ARCHIVE_MIN_SEASON: String(OLDER),
    ARCHIVE_MAX_SEASON: String(OLDER),
    ARCHIVE_SEASON_PAUSE_MS: '0',
    PROFILE_BATCH_SIZE: '200',
    REPRESENTATION_MIN_RATINGS: '0',
  };

  const logger = new CapturingLogger();
  let harness: TestApp;
  let db: Db;

  /** The archive is the only job that touches a season other than the live one. */
  const archiveRequests = () =>
    harness.blizzard.requests.filter((request) => request.path.includes(`pvp-season/${OLDER}`));
  const profileRequests = () =>
    harness.blizzard.requests.filter((request) =>
      request.path.startsWith('profile/wow/character/'),
    );
  const ladderRequests = () =>
    harness.blizzard.requests.filter(
      (request) =>
        request.path.includes(`pvp-season/${SEASON}/pvp-leaderboard/`) &&
        !request.path.endsWith('/index'),
    );

  beforeAll(async () => {
    // Handed to the testing module rather than installed after the fact:
    // everything under test happens inside `app.init()`, which `app.useLogger`
    // is already too late for.
    harness = await bootTestApp(
      World.seed({
        regions: ['us'],
        players: 30,
        seed: 113,
        season: SEASON,
        brackets: [...CORE_BRACKETS, ...AGGREGATE_BRACKETS],
      }),
      ENV,
      undefined,
      logger,
    );
    db = harness.app.get(MongoService).db;
    await harness.settle();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('S1.13 — the bootstrap snapshot defers to the sweep holding the coordinator', () => {
    expect(
      logger.matching(/deferring snapshot/i).length,
      'the snapshot tick fires at boot and finds the sweep already running',
    ).toBeGreaterThan(0);
  });

  it('S1.13b — the sweep runs first and enrichment follows its completion', () => {
    const ladders = ladderRequests();
    const profiles = profileRequests();

    expect(ladders.length, 'the startup sweep really ran').toBeGreaterThan(0);
    expect(profiles.length, 'and the onlyNew pass followed it').toBeGreaterThan(0);

    // Enrichment is driven by `completed$`, so no profile request can predate
    // the last ladder request of the sweep that triggered it.
    const lastLadder = Math.max(...ladders.map((request) => request.at));
    const firstProfile = Math.min(...profiles.map((request) => request.at));
    expect(firstProfile).toBeGreaterThanOrEqual(lastLadder);
  });

  it('S5.1 — the archive makes no request until live ingestion has warmed up', () => {
    const archive = archiveRequests();
    expect(archive.length, 'the backfill did eventually run').toBeGreaterThan(0);

    // Asserted against the fake's request log rather than a spy on the
    // scheduler: what matters is that no quota was spent, not that a method
    // went uncalled.
    const lastProfile = Math.max(...profileRequests().map((request) => request.at));
    const firstArchive = Math.min(...archive.map((request) => request.at));

    expect(
      firstArchive,
      'the backfill waited for both the sweep and the first enrichment pass',
    ).toBeGreaterThanOrEqual(lastProfile);
    expect(logger.matching(/warmed up/i).length, 'and said so').toBeGreaterThan(0);
  });

  it('S1.13c — every job did in fact complete, so the ordering is not vacuous', async () => {
    // An ordering assertion over an empty log passes for the wrong reason.
    const marker = await db
      .collection(ARCHIVE_SEASONS_COLLECTION)
      .findOne({ seasonId: OLDER, region: 'us' });
    expect(marker!.failedBrackets).toEqual([]);
    expect(await db.collection(SPEC_REPRESENTATION_COLLECTION).countDocuments()).toBeGreaterThan(0);
  });
});
