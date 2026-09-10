import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Logger, type LoggerService } from '@nestjs/common';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  BlizzardApiError,
  BlizzardEmptyResponseError,
} from '../src/blizzard/http/blizzard-api.error.js';
import { BlizzardHttpService } from '../src/blizzard/http/blizzard-http.service.js';
import { DependencyHealth } from '../src/common/health/dependency-health.service.js';
import { withRunId } from '../src/common/logging/run-context.js';
import { QuotaBudget } from '../src/common/quota/quota-budget.service.js';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../src/config/env.schema.js';

/** Two retries rather than the default three: got backs off ~1s per attempt,
 * and the classification is just as well proved by three attempts as by four.
 * Kept above PROFILE_RETRY_LIMIT so the two budgets are distinguishable. */
const RETRY_LIMIT = 2;
/** What the per-character endpoints get. Lower on purpose — see the case below. */
const PROFILE_RETRY_LIMIT = 1;
const TIMEOUT_MS = 200;

/**
 * S8.10 / S8.11 / S8.14 / S8.15 — the HTTP client itself.
 *
 * `FakeBlizzard` replaces this service wholesale, so nothing in the integration
 * suite exercises retries, status classification, body parsing or the request
 * timeout. Those are the behaviours that decide whether a Blizzard incident
 * costs one sweep or the whole quota, so they are driven here against a real
 * listener through the `BLIZZARD_API_HOST_TEMPLATE` seam.
 */
describe('BlizzardHttpService — failure handling', () => {
  let server: Server;
  let http: BlizzardHttpService;
  let health: DependencyHealth;
  let budget: QuotaBudget;

  /** No testing module here, so the global logger is the one to intercept. */
  const captured: { level: string; message: string }[] = [];
  const logger: LoggerService = {
    log: (message: unknown) => captured.push({ level: 'log', message: String(message) }),
    error: (message: unknown) => captured.push({ level: 'error', message: String(message) }),
    warn: (message: unknown) => captured.push({ level: 'warn', message: String(message) }),
    debug: (message: unknown) => captured.push({ level: 'debug', message: String(message) }),
    verbose: (message: unknown) => captured.push({ level: 'verbose', message: String(message) }),
  };

  /** What the next request to each path should do. */
  const routes = new Map<string, (request: IncomingMessage, response: ServerResponse) => void>();
  const hits = new Map<string, number>();

  const config = (hostTemplate: string) =>
    ({
      get: (key: keyof Env) =>
        ({
          BLIZZARD_LOCALE: 'en_GB',
          BLIZZARD_API_HOST_TEMPLATE: hostTemplate,
          BLIZZARD_REQUEST_TIMEOUT_MS: TIMEOUT_MS,
          BLIZZARD_RETRY_LIMIT: RETRY_LIMIT,
          PROFILE_RETRY_LIMIT,
          BLIZZARD_CLIENT_ID: 'test-client-id',
          BLIZZARD_CLIENT_SECRET: 'test-client-secret',
          QUOTA_HOURLY_LIMIT: 36_000,
          QUOTA_UTILISATION: 0.9,
          QUOTA_ENRICHMENT_HEADROOM: 3,
          QUOTA_SWEEP_RESERVE: 1_000,
        })[key as string],
    }) as unknown as ConfigService<Env, true>;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname;
      hits.set(path, (hits.get(path) ?? 0) + 1);

      const handler = routes.get(path);
      if (!handler) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"error":"no route"}');

        return;
      }

      handler(request, response);
    });

    Logger.overrideLogger(logger);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    // The region placeholder is required, so it is satisfied and ignored: one
    // listener stands in for every region.
    const settings = config(`http://127.0.0.1:${port}/{region}`);
    health = new DependencyHealth(settings);
    budget = new QuotaBudget(settings);
    http = new BlizzardHttpService(
      settings,
      { getAccessToken: async () => 'test-token' },
      health,
      budget,
    );
  });

  afterEach(() => {
    routes.clear();
    hits.clear();
    captured.length = 0;
  });

  afterAll(async () => {
    Logger.overrideLogger(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const route = (
    path: string,
    handler: (request: IncomingMessage, response: ServerResponse) => void,
  ) => routes.set(`/us/${path}`, handler);
  const hitsFor = (path: string) => hits.get(`/us/${path}`) ?? 0;

  const json =
    (status: number, body: unknown) => (_: IncomingMessage, response: ServerResponse) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };

  it('S8.11 — retries the statuses that can succeed later', async () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      const path = `retry-${status}`;
      route(path, json(status, { error: status }));

      await expect(http.get('us', path)).rejects.toBeInstanceOf(BlizzardApiError);
      expect(hitsFor(path), `${status} should be retried`).toBe(RETRY_LIMIT + 1);
    }
  });

  it('S8.11b — and gives up immediately on the ones that cannot', async () => {
    for (const status of [400, 401, 403, 404]) {
      const path = `fixed-${status}`;
      route(path, json(status, { error: status }));

      await expect(http.get('us', path)).rejects.toBeInstanceOf(BlizzardApiError);
      expect(hitsFor(path), `${status} must not be retried`).toBe(1);
    }
  });

  it('S8.11c — a 404 is distinguishable from every other failure', async () => {
    route('gone', json(404, { error: 'not found' }));
    route('denied', json(403, { error: 'forbidden' }));

    const notFound = await http.get('us', 'gone').catch((error: unknown) => error);
    const forbidden = await http.get('us', 'denied').catch((error: unknown) => error);

    // Enrichment keys "this character no longer exists" off `isNotFound`, and a
    // credential failure mislabelled as a 404 would blank thousands of profiles.
    expect((notFound as BlizzardApiError).isNotFound).toBe(true);
    expect((notFound as BlizzardApiError).statusCode).toBe(404);
    expect((forbidden as BlizzardApiError).isNotFound).toBe(false);
    expect((forbidden as BlizzardApiError).statusCode).toBe(403);
  });

  it('S8.10 — a sustained 429 exhausts the retries and then fails, saying how many', async () => {
    route('throttled', json(429, { error: 'too many requests' }));

    const error = (await http
      .get('us', 'throttled')
      .catch((caught: unknown) => caught)) as BlizzardApiError;

    expect(hitsFor('throttled'), 'the configured limit, not an unbounded loop').toBe(
      RETRY_LIMIT + 1,
    );
    // The attempt count is in the message on purpose: at LOG_LEVEL=error the
    // per-retry warnings are suppressed, and without it a one-shot failure and
    // an exhausted one read identically in the log.
    expect(error.message).toContain(`after ${RETRY_LIMIT + 1} attempts`);
    expect(error.statusCode).toBe(429);
  });

  it('S8.14 — an HTML error page and truncated JSON fail readably', async () => {
    route('html', (_, response) => {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html><body>502 Bad Gateway</body></html>');
    });
    route('truncated', (_, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"entries": [{"rank": 1');
    });

    for (const path of ['html', 'truncated']) {
      const error = await http.get('us', path).catch((caught: unknown) => caught);

      // A parse failure of a 200 is not an HTTP error, so it comes back as the
      // underlying error with the url appended — readable, and not an unhandled
      // rejection.
      expect(error, path).toBeInstanceOf(Error);
      expect((error as Error).message, path).toMatch(/attempt/);
      expect((error as Error).message, path).toContain(path);
    }
  });

  it('S8.11d — a profile fetch gets its own, smaller retry budget', async () => {
    // Enrichment is one request per character per half, so the same retry
    // budget means something very different there than on ~332 ladder fetches:
    // at the defaults, retrying every profile three times puts enrichment alone
    // over the hourly quota and starves the sweep that serves the boards.
    route('character', json(503, { error: 'unavailable' }));
    route('ladder', json(503, { error: 'unavailable' }));

    await expect(http.get('us', 'character', { namespace: 'profile' })).rejects.toBeInstanceOf(
      BlizzardApiError,
    );
    await expect(http.get('us', 'ladder')).rejects.toBeInstanceOf(BlizzardApiError);

    expect(hitsFor('character'), 'per-character endpoints').toBe(PROFILE_RETRY_LIMIT + 1);
    expect(hitsFor('ladder'), 'everything else').toBe(RETRY_LIMIT + 1);
  });

  it('S8.11e — the smaller budget still applies the shared retry rules', async () => {
    // Only the limit differs. A status got does not consider retryable is still
    // attempted exactly once, so the narrower budget cannot be read as
    // "profile calls retry on things ladder calls do not".
    route('character-404', json(404, { error: 'gone' }));

    await expect(http.get('us', 'character-404', { namespace: 'profile' })).rejects.toBeInstanceOf(
      BlizzardApiError,
    );

    expect(hitsFor('character-404')).toBe(1);
  });

  it('QUOTA — every attempt is charged, retries included', async () => {
    // Blizzard counts a retry exactly like a first attempt, so a budget that
    // counted calls rather than attempts would under-report during precisely
    // the incidents where the quota is under the most pressure.
    route('charged', json(503, { error: 'unavailable' }));
    const before = budget.spent();

    await http.get('us', 'charged').catch(() => undefined);

    expect(hitsFor('charged')).toBe(RETRY_LIMIT + 1);
    expect(budget.spent() - before, 'one charge per attempt the server saw').toBe(
      hitsFor('charged'),
    );
  });

  it('QUOTA — a request is charged to the job it was made for', async () => {
    route('attributed', json(200, { ok: true }));
    const enrichmentBefore = budget.spent('enrichment');
    const archiveBefore = budget.spent('archive');
    const otherBefore = budget.spent('other');

    await withRunId('enrich', () => http.get('us', 'attributed'));
    await withRunId('archive', () => http.get('us', 'attributed'));
    await http.get('us', 'attributed');

    // Attributed from the run in progress, so no call site has to say which
    // job it belongs to — and a season refresh inside a sweep is the sweep's.
    expect(budget.spent('enrichment') - enrichmentBefore).toBe(1);
    expect(budget.spent('archive') - archiveBefore).toBe(1);
    expect(budget.spent('other') - otherBefore, 'outside any job').toBe(1);
  });

  it('S8.14b — an empty 200 body is rejected as a transport failure', async () => {
    route('empty', (_, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('');
    });

    // got returns '' for an empty body rather than raising a parse error, so
    // left alone the emptiness surfaces one layer up at the zod boundary — and
    // the enrichment path reads a ZodError as *permanent*, parking the
    // character for a week. An empty body from a flaky gateway is as transient
    // as a 502, so it is caught here, where the client still knows it answered
    // 200 with nothing.
    const error = await http.get('us', 'empty').catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BlizzardEmptyResponseError);
    expect((error as Error).message).toMatch(/empty response body/);
    // Not a BlizzardApiError: the response was a 2xx, so calling it one would
    // put a 200 into the sweep's failure digest.
    expect(error).not.toBeInstanceOf(BlizzardApiError);
  });

  it('S8.14c — an empty 200 counts against Blizzard health, not for it', async () => {
    route('empty-health', (_, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('');
    });

    await http.get('us', 'empty-health').catch(() => undefined);

    // A gateway shedding load answers 200 with nothing. Recording that as a
    // success is how readiness reports green through an outage.
    const observed = health.blizzardByRegion().us;
    expect(observed.consecutiveFailures).toBeGreaterThan(0);
    expect(observed.lastError).toMatch(/empty response body/);
  });

  it('S8.15 — a route that never answers is bounded by the timeout', async () => {
    const held: ServerResponse[] = [];
    route('hangs', (_, response) => {
      held.push(response);
    });

    const startedAt = Date.now();
    const error = await http.get('us', 'hangs').catch((caught: unknown) => caught);
    const elapsed = Date.now() - startedAt;

    for (const response of held) response.destroy();

    expect((error as Error).message).toMatch(/timeout|Timeout/i);
    expect(hitsFor('hangs'), 'a timeout is retried like any transient failure').toBe(
      RETRY_LIMIT + 1,
    );
    // Roughly timeout x attempts, plus got's backoff between them. The claim
    // that matters is that it is bounded at all: a hung route must not hang the
    // sweep behind it.
    expect(elapsed, `${elapsed}ms elapsed`).toBeLessThan(TIMEOUT_MS * (RETRY_LIMIT + 1) + 5_000);
  });

  it('S10.3 — a request that recovers is logged as a retry, never as a failure', async () => {
    // 503, then 200. A transient blip must not read like an outage: an operator
    // scanning for `ERROR` at three in the morning should find nothing here.
    let attempt = 0;
    route('flaky', (_, response) => {
      attempt += 1;
      if (attempt === 1) {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end('{"error":"unavailable"}');

        return;
      }

      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"recovered":true}');
    });

    await expect(http.get('us', 'flaky')).resolves.toEqual({ recovered: true });

    const retries = captured.filter(
      (line) => line.level === 'warn' && /^Retry /.test(line.message),
    );
    expect(retries.length, 'the retry is visible').toBe(1);
    // The url, so the line can be tied to a bracket, and the attempt number, so
    // a run of them can be counted without parsing prose.
    expect(retries[0].message).toContain('flaky');
    expect(retries[0].message).toMatch(/^Retry 1 /);
    expect(
      captured.filter((line) => line.level === 'error'),
      'and nothing failed',
    ).toEqual([]);
  });

  it('reports what it observed to the health service', async () => {
    route('ok', json(200, { fine: true }));
    route('bad', json(500, { error: 'boom' }));

    await http.get('us', 'ok');
    const healthy = health.blizzardByRegion().us;
    expect(healthy.status).toBe('ok');
    expect(healthy.lastSuccessAt).not.toBeNull();

    await http.get('us', 'bad').catch(() => undefined);
    expect(health.blizzardByRegion().us.lastError, 'the failure is recorded too').toContain('500');
  });
});
