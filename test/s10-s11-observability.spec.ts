import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from 'mongodb';
import type { LoggerService } from '@nestjs/common';

import { IngestionCoordinator } from '../src/common/ingestion-coordinator.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { SweepEvents } from '../src/common/events/sweep-events.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { getJson } from './support/http.js';
import { World } from './support/world.js';

interface Captured {
  level: string;
  message: string;
  stack?: string;
  context?: string;
}

/** Records what actually reaches the transport, fields and all. */
class CapturingLogger implements LoggerService {
  readonly records: Captured[] = [];

  private push(level: string, message: unknown, ...rest: unknown[]) {
    this.records.push({
      level,
      message: typeof message === 'string' ? message : JSON.stringify(message),
      stack: typeof rest[0] === 'string' ? rest[0] : undefined,
      context: typeof rest.at(-1) === 'string' ? (rest.at(-1) as string) : undefined,
    });
  }

  log = (m: unknown, ...r: unknown[]) => this.push('log', m, ...r);
  error = (m: unknown, ...r: unknown[]) => this.push('error', m, ...r);
  warn = (m: unknown, ...r: unknown[]) => this.push('warn', m, ...r);
  debug = (m: unknown, ...r: unknown[]) => this.push('debug', m, ...r);
  verbose = (m: unknown, ...r: unknown[]) => this.push('verbose', m, ...r);

  reset() {
    this.records.length = 0;
  }

  of(level: string) {
    return this.records.filter((record) => record.level === level);
  }

  matching(pattern: RegExp) {
    return this.records.filter((record) => pattern.test(record.message));
  }
}

/**
 * S10 / S11 — logging and health.
 *
 * When a sweep reports 12/332 at three in the morning, the logs and the health
 * endpoint are the only artefacts anyone has. Assertions are on fields rather
 * than wording: a test that breaks when someone improves a sentence teaches
 * people to delete tests.
 */
describe('S10 / S11 — observability', () => {
  let harness: TestApp;
  let db: Db;
  let baseUrl: string;
  const logger = new CapturingLogger();

  const sweep = () => harness.app.get(LeaderboardService).sweep();

  beforeAll(async () => {
    harness = await bootTestApp(World.seed({ regions: ['us', 'eu'], players: 40, seed: 10 }), {
      LOG_LEVEL: 'debug',
    });
    db = harness.app.get(MongoService).db;
    harness.app.useLogger(logger);
    baseUrl = await harness.listen();
    await sweep();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  describe('S10 — logging', () => {
    it('S10.2 — a failed bracket is diagnosable from one line', async () => {
      logger.reset();
      harness.world.fail('us', 'shuffle-mage-fire', 503);
      await sweep();
      harness.world.clearFaults();

      const failures = logger
        .of('error')
        .filter((record) => record.message.includes('shuffle-mage-fire'));

      expect(failures.length, 'exactly one error line for the failed bracket').toBe(1);
      const [line] = failures;
      expect(line.message, 'names the region').toContain('us');
      expect(line.message, 'names the status').toContain('503');
      expect(line.message, 'names the url').toContain('pvp-leaderboard');
    });

    it('S10.4 — a terminal failure states the attempts spent', async () => {
      logger.reset();
      harness.world.fail('us', '3v3', 500);
      await sweep();
      harness.world.clearFaults();

      const [line] = logger.of('error').filter((record) => /\/3v3\b/.test(record.message));

      expect(line, 'the failure is reported').toBeDefined();
      expect(line.message, 'a one-shot failure reads differently from an exhausted one').toMatch(
        /attempt/i,
      );
    });

    it('S10.5 / S10.10 — a schema failure is one readable line, not a JSON wall', async () => {
      logger.reset();
      harness.world.corrupt('us', 'rbg', {
        season: { id: 42 },
        name: 'rbg',
        bracket: { id: 3, type: 'RBG' },
        entries: [
          {
            character: { id: 5551, name: 'Bad', realm: { id: 60, slug: 'tarren-mill' } },
            rank: 1,
            rating: 'nope',
          },
        ],
      });
      await sweep();
      harness.world.corrupt('us', 'rbg', undefined);

      const [line] = logger.of('error').filter((record) => /\/rbg\b/.test(record.message));

      expect(line).toBeDefined();
      expect(line.message, 'names the failing path').toContain('entries.0.rating');
      expect(line.message, 'says how many issues there were').toMatch(/\d+ schema issue/);
      expect(line.message, 'and stays on one line').not.toContain('\n');
    });

    it('S10.10 — no log message anywhere contains a raw newline', () => {
      const multiline = logger.records.filter((record) => record.message.includes('\n'));

      expect(
        multiline.map((record) => record.message.slice(0, 60)),
        'a multi-line message is split into unrelated records by line-oriented shipping',
      ).toEqual([]);
    });

    it('S10.7 — no secret reaches a log line', () => {
      const secrets = ['test-client-secret', 'test-token'];

      for (const record of logger.records) {
        for (const secret of secrets) {
          expect(record.message, `secret in a ${record.level} line`).not.toContain(secret);
          expect(record.stack ?? '').not.toContain(secret);
        }
      }
    });

    it('S10.8 — the sweep summarises which brackets failed, grouped by status', async () => {
      logger.reset();
      harness.world.fail('us', '2v2', 500);
      harness.world.fail('us', 'rbg', 503);
      await sweep();
      harness.world.clearFaults();

      const digest = logger
        .of('warn')
        .filter((record) => /Failed \d+ bracket/.test(record.message));

      expect(digest.length, 'one digest line per status code').toBe(2);
      expect(digest.map((record) => record.message).join(' ')).toContain('2v2');
      expect(digest.map((record) => record.message).join(' ')).toContain('rbg');
      expect(digest.some((record) => record.message.includes('500'))).toBe(true);
      expect(digest.some((record) => record.message.includes('503'))).toBe(true);
    });

    it('S10.8b — a clean sweep emits no digest line', async () => {
      logger.reset();
      await sweep();

      expect(logger.of('warn').filter((r) => /Failed \d+ bracket/.test(r.message))).toEqual([]);
    });

    it('S10.9 — every line of one run shares a run id, and runs differ', async () => {
      logger.reset();
      await sweep();
      const first = logger.matching(/\[sweep [0-9a-z]+\]/);
      const firstIds = new Set(first.map((r) => /\[sweep ([0-9a-z]+)\]/.exec(r.message)![1]));

      logger.reset();
      await sweep();
      const secondIds = new Set(
        logger
          .matching(/\[sweep [0-9a-z]+\]/)
          .map((r) => /\[sweep ([0-9a-z]+)\]/.exec(r.message)![1]),
      );

      expect(firstIds.size, 'one id for the whole run').toBe(1);
      expect(secondIds.size).toBe(1);
      expect([...secondIds][0], 'two sweeps are distinguishable').not.toBe([...firstIds][0]);
    });

    it('S10.11 — the quiet path stays quiet', async () => {
      logger.reset();
      // Nothing has changed since the last sweep, so this is the steady state.
      await sweep();

      expect(logger.of('error')).toEqual([]);
      expect(logger.of('warn')).toEqual([]);
    });
  });

  describe('S11 — health', () => {
    it('S11.1 — healthy reports both dependencies up', async () => {
      const live = await getJson<{ status: string; jobs: Record<string, unknown> }>(
        baseUrl,
        '/health',
      );
      expect(live.status).toBe(200);
      expect(live.body.status).toBe('ok');
      expect(live.body.jobs).toMatchObject({ warmedUp: expect.any(Boolean) });

      const ready = await getJson<{
        status: string;
        dependencies: { mongo: { status: string }; blizzard: { status: string } };
      }>(baseUrl, '/health/ready');

      expect(ready.status).toBe(200);
      expect(ready.body.status).toBe('ok');
      expect(ready.body.dependencies.mongo.status).toBe('ok');
      expect(ready.body.dependencies.blizzard.status).toBe('ok');
    });

    it('S11.2 — Mongo down fails readiness but never liveness', async () => {
      const mongo = harness.app.get(MongoService);
      const spy = vi.spyOn(mongo, 'ping').mockResolvedValue({
        ok: false,
        latencyMs: 12,
        error: 'connection <monitor> to 127.0.0.1:27017 closed',
      });

      const ready = await getJson<{ status: string }>(baseUrl, '/health/ready');
      const live = await getJson<{ status: string }>(baseUrl, '/health');

      expect(ready.status, 'traffic is withdrawn').toBe(503);
      expect(live.status, 'but the process is alive and will recover').toBe(200);
      expect(live.body.status).toBe('ok');

      spy.mockRestore();
      expect((await getJson<{ status: string }>(baseUrl, '/health/ready')).status).toBe(200);
    });

    it('S11.3 / S11.8 — a failing region degrades without failing readiness', async () => {
      harness.world.fail('kr', 'index', 500);
      harness.world.fail('eu', 'brackets', 503);
      await sweep();
      harness.world.clearFaults();

      const ready = await getJson<{
        status: string;
        dependencies: { blizzard: { status: string; failingRegions: string[] } };
      }>(baseUrl, '/health/ready');

      // A Blizzard outage must never restart-loop the service through an
      // incident it cannot fix.
      expect(ready.status, 'still serving').toBe(200);
      expect(ready.body.status).toBe('degraded');
      expect(ready.body.dependencies.blizzard.failingRegions).toContain('eu');
      expect(
        ready.body.dependencies.blizzard.failingRegions,
        'a healthy region is not tarred with it',
      ).not.toContain('us');
    });

    it('S11.5 — recovery flips the status back', async () => {
      await sweep();

      const ready = await getJson<{
        status: string;
        dependencies: { blizzard: { status: string; regions: Record<string, unknown> } };
      }>(baseUrl, '/health/ready');

      expect(ready.body.dependencies.blizzard.status).toBe('ok');
      expect(ready.body.status).toBe('ok');
    });

    it('S11.6 — health checks cannot be turned into a quota drain', async () => {
      harness.blizzard.reset();
      const pings = vi.spyOn(harness.app.get(MongoService), 'ping');

      await Promise.all(Array.from({ length: 30 }, () => getJson(baseUrl, '/health/ready')));

      expect(harness.blizzard.requests.length, 'Blizzard is observed, never probed').toBe(0);
      // The ping result is cached, so a burst does not become a burst of
      // commands against the primary.
      const distinct = await pings.mock.results.reduce(async (acc, result) => {
        const seen = await acc;
        seen.add(JSON.stringify(await result.value));
        return seen;
      }, Promise.resolve(new Set<string>()));
      expect(distinct.size).toBeLessThanOrEqual(2);

      pings.mockRestore();
      await getJson(baseUrl, '/health');
      expect(harness.blizzard.requests.length, 'liveness does no I/O at all').toBe(0);
    });

    it('S11.9 — job state and the last sweep are reported', async () => {
      await sweep();
      const live = await getJson<{
        jobs: { lastSweep: { brackets: number; failed: number } | null; warmedUp: boolean };
      }>(baseUrl, '/health');

      expect(live.body.jobs.lastSweep).not.toBeNull();
      expect(live.body.jobs.lastSweep!.brackets).toBe(83 * 2);
      expect(live.body.jobs.lastSweep!.failed).toBe(0);
    });

    it('S11.7 — a stale sweep degrades health even when both dependencies are up', async () => {
      const sweeps = harness.app.get(SweepEvents);
      const last = sweeps.last!;
      // Two intervals of grace, so one skipped tick is not an alarm.
      Object.defineProperty(sweeps, 'last', {
        configurable: true,
        get: () => ({ ...last, finishedAt: new Date(Date.now() - 5 * 3_600_000) }),
      });

      const ready = await getJson<{ status: string; staleSweep: unknown }>(
        baseUrl,
        '/health/ready',
      );

      expect(ready.status, 'the data stopping is not a reason to withdraw traffic').toBe(200);
      expect(ready.body.status).toBe('degraded');
      expect(ready.body.staleSweep).not.toBeNull();

      delete (sweeps as unknown as Record<string, unknown>).last;
    });

    it('S11.4 — throttling is reported as degraded and named as throttling', async () => {
      // "We are throttled" and "our credentials died" call for completely
      // different responses at three in the morning, and both arrive as a
      // degraded readiness. The status code is what separates them.
      for (const bracket of harness.world.brackets('eu')) harness.world.fail('eu', bracket, 429);

      try {
        await sweep();
        const ready = await getJson<{
          status: string;
          dependencies: {
            blizzard: {
              failingRegions: string[];
              regions: Record<
                string,
                { lastStatusCode: number | null; consecutiveFailures: number }
              >;
            };
          };
        }>(baseUrl, '/health/ready');

        expect(ready.status, 'an upstream limit does not withdraw traffic').toBe(200);
        expect(ready.body.status).toBe('degraded');
        expect(ready.body.dependencies.blizzard.failingRegions).toContain('eu');
        expect(
          ready.body.dependencies.blizzard.regions.eu.lastStatusCode,
          'the status is carried through, not flattened into a boolean',
        ).toBe(429);
        expect(ready.body.dependencies.blizzard.regions.eu.consecutiveFailures).toBeGreaterThan(1);
      } finally {
        harness.world.clearFaults();
      }
    });

    it('S11.12 — readiness during a sweep is still ready', async () => {
      // `sweepRunning` is information, not a fault, and the Mongo ping must not
      // queue behind the sweep's own I/O long enough to trip a probe timeout.
      harness.world.clearFaults();
      await sweep();

      const coordinator = harness.app.get(IngestionCoordinator);
      const probe = await coordinator.duringSweep(async () => {
        const startedAt = Date.now();
        const response = await getJson<{ status: string }>(baseUrl, '/health/ready');

        return { response, elapsed: Date.now() - startedAt };
      });

      expect(probe.response.status).toBe(200);
      expect(probe.response.body.status).not.toBe('down');
      expect(probe.elapsed, `readiness took ${probe.elapsed}ms while a sweep held`).toBeLessThan(
        2_000,
      );

      const live = await getJson<{ sweepRunning: boolean }>(baseUrl, '/health');
      expect(live.status).toBe(200);
    });

    it('S11.13 — the three states map to stable HTTP codes', async () => {
      const mongo = harness.app.get(MongoService);

      // ok
      expect((await getJson(baseUrl, '/health')).status).toBe(200);
      expect((await getJson(baseUrl, '/health/ready')).status).toBe(200);

      // degraded: a soft dependency is failing
      for (const bracket of harness.world.brackets('eu')) harness.world.fail('eu', bracket, 503);
      await sweep();
      const degraded = await getJson<{ status: string }>(baseUrl, '/health/ready');
      expect(degraded.body.status).toBe('degraded');
      expect(degraded.status, 'degraded still takes traffic').toBe(200);
      expect((await getJson(baseUrl, '/health')).status).toBe(200);
      harness.world.clearFaults();

      // down: the hard dependency is gone
      const ping = vi
        .spyOn(mongo, 'ping')
        .mockResolvedValue({ ok: false, latencyMs: 1, error: 'connection refused' });
      try {
        const down = await getJson<{ status: string }>(baseUrl, '/health/ready');
        expect(down.status, 'only a hard dependency withdraws traffic').toBe(503);
        expect(down.body.status).toBe('down');
        expect(
          (await getJson(baseUrl, '/health')).status,
          'liveness answers regardless: restarting would not fix the database',
        ).toBe(200);
      } finally {
        ping.mockRestore();
      }
    });

    it('S10.6 — a stack trace survives all the way to the transport', async () => {
      // `Logger.error(message, stack?, context?)` takes a *string* second
      // argument. Passing the Error object put `[object Object]` where the
      // stack should be, and the loss was invisible in every field assertion —
      // which is why this one asserts the record that actually reached the
      // logger rather than what was passed to it.
      //
      // The bracket index, not a single ladder: the per-bracket failure line is
      // deliberately stackless (one line per bracket, 83 of them), while the
      // handlers that lose a whole region are the ones worth a stack.
      logger.reset();
      harness.world.fail('us', 'brackets', 500);

      try {
        await sweep();
      } finally {
        harness.world.clearFaults();
      }

      const failures = logger
        .of('error')
        .filter((record) => /Could not resolve brackets for us/.test(record.message));

      expect(failures.length, 'the region failure was logged').toBeGreaterThan(0);
      expect(
        failures.every(
          (record) => typeof record.stack === 'string' && record.stack.includes('at '),
        ),
        'the second argument carries a real stack, not a stringified Error',
      ).toBe(true);
      expect(failures.every((record) => !String(record.stack).includes('[object Object]'))).toBe(
        true,
      );
      expect(failures[0].message.split(String.fromCharCode(10))).toHaveLength(1);
    });

    it('S11.10 — the health payload leaks no credentials', async () => {
      const ready = await getJson(baseUrl, '/health/ready');
      const live = await getJson(baseUrl, '/health');
      const seasons = await getJson(baseUrl, '/health/seasons');

      for (const response of [ready, live, seasons]) {
        expect(response.text).not.toContain('test-client-secret');
        expect(response.text).not.toContain('test-client-id');
        // A host is fine; a connection string is not.
        expect(response.text).not.toContain('mongodb://');
      }
    });
  });
});
