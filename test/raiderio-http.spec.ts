import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Logger, type LoggerService } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import { DependencyHealth } from '../src/common/health/dependency-health.service.js';
import { withRunId } from '../src/common/logging/run-context.js';
import { RaiderIoBudget } from '../src/common/quota/raiderio-budget.service.js';
import type { Env } from '../src/config/env.schema.js';
import {
  RaiderIoApiError,
  RaiderIoEmptyResponseError,
} from '../src/raiderio/http/raiderio-api.error.js';
import { RaiderIoHttpService } from '../src/raiderio/http/raiderio-http.service.js';
import { RaiderIoServer } from './support/raiderio-server.js';

const KEY = 'rio-key-SENTINEL';
const STATIC = 'mythic-plus/static-data';

/**
 * M10.1-M10.6, M10.8 — `RaiderIoHttpService` itself, against a real listener.
 *
 * `FakeRaiderIo` replaces this class at the seam in every other file, on
 * purpose, so everything the class promises has been unverified: retries and
 * which statuses earn one, `Retry-After`, the access key added last and kept
 * out of every message, the empty-body check, and the token bucket. The
 * Raider.io counterpart of `blizzard-http.spec.ts`.
 */
describe('RaiderIoHttpService — against a real listener', () => {
  const server = new RaiderIoServer();
  let baseUrl: string;

  const captured: { level: string; message: string }[] = [];
  const logger: LoggerService = {
    log: (message: unknown) => captured.push({ level: 'log', message: String(message) }),
    error: (message: unknown) => captured.push({ level: 'error', message: String(message) }),
    warn: (message: unknown) => captured.push({ level: 'warn', message: String(message) }),
    debug: (message: unknown) => captured.push({ level: 'debug', message: String(message) }),
    verbose: (message: unknown) => captured.push({ level: 'verbose', message: String(message) }),
  };

  /**
   * A client, with its own health and budget, configured as the app wires
   * them: one config, so `DependencyHealth` knows the key it redacts. The client
   * relies on that for messages got builds itself (`safe`), which quote the
   * url with the key already added.
   */
  const clientFor = (
    settings: Partial<Record<keyof Env, unknown>> = {},
    url = baseUrl,
    healthKnowsKey = true,
  ) => {
    const values: Record<string, unknown> = {
      RAIDERIO_API_BASE_URL: url,
      RAIDER_IO_API_KEY: KEY,
      RAIDERIO_REQUESTS_PER_SECOND: 1_000,
      RAIDERIO_REQUEST_TIMEOUT_MS: 2_000,
      RAIDERIO_RETRY_LIMIT: 1,
      RAIDERIO_MINUTE_LIMIT: 100_000,
      RAIDERIO_UTILISATION: 0.9,
      RAIDERIO_ARCHIVE_SHARE: 0.5,
      BLIZZARD_CLIENT_ID: 'id',
      BLIZZARD_CLIENT_SECRET: 'secret',
      ...settings,
    };
    const config = { get: (key: string) => values[key] } as unknown as ConfigService<Env, true>;
    const health = new DependencyHealth(
      healthKnowsKey
        ? config
        : ({
            get: (key: string) => (key === 'RAIDER_IO_API_KEY' ? '' : values[key]),
          } as unknown as ConfigService<Env, true>),
    );
    const budget = new RaiderIoBudget(config);

    return { http: new RaiderIoHttpService(config, health, budget), health, budget };
  };

  const answer = (status: number, body: unknown = { error: status }, headers = {}) =>
    ((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(typeof body === 'string' ? body : JSON.stringify(body));

      return true;
    }) satisfies RaiderIoServer['handler'];

  /** Answers each successive hit from the list, then lets the world answer. */
  const sequence = (...handlers: NonNullable<RaiderIoServer['handler']>[]) => {
    let index = 0;
    server.handler = (request, response, hit) =>
      handlers[index++]?.(request, response, hit) ?? false;
  };

  const failureOf = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      return error as Error;
    }
    throw new Error('expected the call to fail');
  };

  beforeAll(async () => {
    baseUrl = await server.start();
    Logger.overrideLogger(logger);
  });

  afterEach(() => {
    server.reset();
    captured.length = 0;
  });

  afterAll(async () => {
    Logger.overrideLogger(false);
    await server.stop();
  });

  it('M10.1 retries a 5xx, and charges every attempt to the run that made it', async () => {
    const { http, health, budget } = clientFor({ RAIDERIO_RETRY_LIMIT: 2 });
    sequence(answer(500), answer(500));

    const payload = await withRunId('mplus', () =>
      http.get(STATIC, { searchParams: { expansion_id: 11 } }),
    );

    expect((payload as { seasons: unknown[] }).seasons.length).toBeGreaterThan(0);
    expect(server.hitsFor(STATIC)).toHaveLength(3);
    expect(budget.spent('mplus'), 'a retry is a real request').toBe(3);
    expect(budget.spent('other')).toBe(0);
    expect(health.statusFor('raiderio')).toBe('ok');

    await http.get(STATIC, { searchParams: { expansion_id: 11 } });
    expect(budget.spent('other'), 'outside a run, the catch-all').toBe(1);
  });

  it('M10.2 does not retry 400 or 404, and retries 408, 429 and the 5xx family', async () => {
    const { http } = clientFor({ RAIDERIO_RETRY_LIMIT: 1 });

    server.handler = answer(400, { message: '"page" must be less than or equal to 1000' });
    const badRequest = await failureOf(
      http.get('mythic-plus/runs', { searchParams: { page: 1001 } }),
    );
    expect(badRequest).toBeInstanceOf(RaiderIoApiError);
    expect((badRequest as RaiderIoApiError).isBadRequest).toBe(true);
    expect(badRequest.message).toMatch(/after 1 attempt:/);
    expect(server.hitsFor('mythic-plus/runs')).toHaveLength(1);

    server.reset();
    server.handler = answer(404, { message: 'Could not find' });
    const notFound = await failureOf(http.get('mythic-plus/season-cutoffs'));
    expect((notFound as RaiderIoApiError).isNotFound).toBe(true);
    expect(server.hitsFor('mythic-plus/season-cutoffs')).toHaveLength(1);

    for (const status of [408, 429, 500, 502, 503, 504]) {
      server.reset();
      server.handler = answer(status);

      const error = await failureOf(http.get(STATIC));

      expect((error as RaiderIoApiError).statusCode, `status ${status}`).toBe(status);
      expect(server.hitsFor(STATIC), `status ${status} is retried`).toHaveLength(2);
      expect(error.message).toMatch(/after 2 attempts:/);
    }
  }, 30_000);

  it('M10.3 honours Retry-After, and refuses one longer than the request timeout', async () => {
    const { http } = clientFor({ RAIDERIO_REQUEST_TIMEOUT_MS: 1_500 });

    sequence(answer(429, { error: 'slow down' }, { 'retry-after': '1' }));
    await http.get(STATIC, { searchParams: { expansion_id: 11 } });
    const [first, second] = server.hitsFor(STATIC);
    expect(second.at - first.at, 'waited as long as it was asked to').toBeGreaterThanOrEqual(950);

    server.reset();
    server.handler = answer(429, { error: 'come back later' }, { 'retry-after': '5' });
    const startedAt = Date.now();
    const error = await failureOf(http.get(STATIC));
    expect((error as RaiderIoApiError).statusCode).toBe(429);
    expect(server.hitsFor(STATIC), 'not parked for five seconds').toHaveLength(1);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('M10.4 sends the access key on every request, and puts it nowhere a person can read', async () => {
    // A success, an HTTP error with retries (so beforeRetry logs), a timeout,
    // and a refused connection.
    const { http, health } = clientFor({ RAIDERIO_REQUEST_TIMEOUT_MS: 200 });
    const messages: string[] = [];

    await http.get(STATIC, { searchParams: { expansion_id: 11 } });

    server.handler = answer(503);
    const httpError = await failureOf(
      http.get('mythic-plus/runs', { region: 'us', searchParams: { region: 'us', page: 0 } }),
    );
    messages.push(httpError.message, httpError.stack ?? '');

    server.handler = () => true; // accepted, never answered
    const timeout = await failureOf(
      http.get('mythic-plus/runs', { region: 'eu', searchParams: { region: 'eu', page: 0 } }),
    );
    messages.push(timeout.message, timeout.stack ?? '');

    const dead = new RaiderIoServer();
    const deadUrl = await dead.start();
    await dead.stop();
    const { http: refused, health: refusedHealth } = clientFor({}, deadUrl);
    const connection = await failureOf(refused.get(STATIC));
    messages.push(connection.message, connection.stack ?? '');

    expect(server.hits.length).toBeGreaterThanOrEqual(5);
    for (const hit of server.hits) expect(hit.query.get('access_key')).toBe(KEY);

    expect(captured.filter((line) => /Retry \d/.test(line.message)).length).toBeGreaterThan(0);
    messages.push(...captured.map((line) => line.message));
    messages.push(
      JSON.stringify(health.byRegion('raiderio')),
      JSON.stringify(refusedHealth.byRegion('raiderio')),
    );

    for (const message of messages) expect(message).not.toContain(KEY);
    // And without relying on redaction: the url the client builds and reports
    // is the one without the key, which is added only as the request leaves.
    expect((httpError as RaiderIoApiError).url).not.toMatch(/access_key/);
    expect((httpError as RaiderIoApiError).url).toMatch(/\/api\/v1\/mythic-plus\/runs$/);
    expect(timeout.message).toMatch(
      /\(2 attempts for http:\/\/127\.0\.0\.1:\d+\/api\/v1\/mythic-plus\/runs\)/,
    );
  });

  it('M10.4 keeps the key out without relying on health knowing it', async () => {
    // Health configured without the key: its redaction cannot help, so only
    // the client's own stripping stands between got's messages and a reader.
    const { http, health } = clientFor({}, baseUrl, false);
    server.handler = answer(503);

    const error = await failureOf(http.get(STATIC, { region: 'us' }));

    const retries = captured.filter((line) => /Retry \d/.test(line.message));
    expect(retries.length).toBeGreaterThan(0);
    for (const text of [
      error.message,
      error.stack ?? '',
      ...retries.map((line) => line.message),
      JSON.stringify(health.byRegion('raiderio')),
    ]) {
      expect(text).not.toContain(KEY);
    }
  });

  it('M10.5 an empty 2xx body is a failure, not a success', async () => {
    const { http, health } = clientFor();
    server.handler = answer(200, '');

    const error = await failureOf(http.get(STATIC, { region: 'us' }));

    expect(error).toBeInstanceOf(RaiderIoEmptyResponseError);
    const us = health.byRegion('raiderio').us;
    expect(us.lastSuccessAt, 'no success recorded').toBeNull();
    expect(us.lastStatusCode, 'a failure with no status').toBeNull();
    expect(us.consecutiveFailures).toBe(1);
    expect(health.statusFor('raiderio')).not.toBe('ok');
  });

  it('M10.6 paces requests across call sites, with one bucket for the client', async () => {
    const { http, budget } = clientFor({ RAIDERIO_REQUESTS_PER_SECOND: 20 });

    // 60 requests from two jobs at once. The bucket starts full, so 20 go at
    // once and 40 more take two seconds — if the pacing is shared. Paced per
    // caller, the two halves would each take one.
    await Promise.all(
      Array.from({ length: 60 }, (_unused, index) =>
        withRunId(index % 2 === 0 ? 'mplus' : 'mplus-archive', () =>
          http.get(STATIC, { searchParams: { expansion_id: 11 } }),
        ),
      ),
    );

    const hits = server.hitsFor(STATIC);
    expect(hits).toHaveLength(60);
    expect(hits[hits.length - 1].at - hits[0].at).toBeGreaterThanOrEqual(1_900);
    expect(budget.spent('mplus')).toBe(30);
    expect(budget.spent('mplusArchive')).toBe(30);
  });

  it('M10.8 a timeout is retried, then reported with its attempt count', async () => {
    const { http, health, budget } = clientFor({ RAIDERIO_REQUEST_TIMEOUT_MS: 200 });
    server.handler = () => true;

    const error = await withRunId('mplus', () =>
      failureOf(
        http.get('mythic-plus/runs', { region: 'us', searchParams: { region: 'us', page: 3 } }),
      ),
    );

    expect(server.hitsFor('mythic-plus/runs')).toHaveLength(2);
    expect(error.message).toMatch(
      /\(2 attempts for http:\/\/127\.0\.0\.1:\d+\/api\/v1\/mythic-plus\/runs\)/,
    );
    expect(error.message).not.toContain(KEY);
    expect(budget.spent('mplus')).toBe(2);
    expect(health.byRegion('raiderio').us).toMatchObject({
      consecutiveFailures: 1,
      lastStatusCode: null,
    });
  });
});
