import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import got, { HTTPError, RequestError, type Got } from 'got';

import { DependencyHealth } from '../../common/health/dependency-health.service.js';
import { currentRunKind } from '../../common/logging/run-context.js';
import {
  RaiderIoBudget,
  raiderIoConsumerFor,
  type RaiderIoConsumer,
} from '../../common/quota/raiderio-budget.service.js';
import { RateLimiter } from '../../common/utils/rate-limiter.js';
import type { Env } from '../../config/env.schema.js';
import { RaiderIoApiError, RaiderIoEmptyResponseError } from './raiderio-api.error.js';

/**
 * Whether a parsed body carries nothing at all. See
 * `RaiderIoEmptyResponseError` for why this is caught here and not at the zod
 * boundary.
 */
function isEmptyBody(payload: unknown): boolean {
  return payload === '' || payload === null || payload === undefined;
}

/** Requests actually spent on a failure — got counts retries from zero. */
function attemptsSpent(error: unknown): number {
  return error instanceof RequestError ? (error.request?.retryCount ?? 0) + 1 : 1;
}

export interface RaiderIoGetOptions {
  /** Query parameters. The access key is added by the client, never here. */
  searchParams?: Record<string, string | number>;
  /**
   * The region the call is about, for per-region health. Not every endpoint has
   * one — the static data is global — so it is explicit rather than derived.
   */
  region?: string;
}

/**
 * Single got instance shared by every Raider.io call: the access key, retries
 * with backoff, per-second pacing and per-attempt budget accounting.
 *
 * Mirrors `BlizzardHttpService`, with two deliberate differences.
 *
 * The access key travels as a **query parameter**, which Raider.io requires and
 * which means it lands inside every url — including the ones got bakes into its
 * own error messages. It is therefore added in `beforeRequest`, exactly where
 * the bearer token is added for Blizzard, so the url this class builds, logs
 * and reports never contains it; `DependencyHealth` redacts it as a second line
 * of defence for messages this class did not build.
 *
 * And the token bucket lives here rather than in the job. `RAIDERIO_MINUTE_LIMIT`
 * is a per-minute ceiling, so pacing has to hold across every call site that
 * shares the budget, not just the one loop that happens to be the biggest
 * spender — the mistake `QuotaBudget`'s header records, made one layer down.
 */
@Injectable()
export class RaiderIoHttpService {
  private readonly logger = new Logger(RaiderIoHttpService.name);
  private readonly client: Got;
  private readonly baseUrl: string;
  private readonly accessKey: string;
  private readonly limiter: RateLimiter;

  constructor(
    config: ConfigService<Env, true>,
    private readonly health: DependencyHealth,
    private readonly budget: RaiderIoBudget,
  ) {
    this.baseUrl = config.get('RAIDERIO_API_BASE_URL', { infer: true });
    this.accessKey = config.get('RAIDER_IO_API_KEY', { infer: true });
    this.limiter = new RateLimiter(config.get('RAIDERIO_REQUESTS_PER_SECOND', { infer: true }));

    this.client = got.extend({
      timeout: { request: config.get('RAIDERIO_REQUEST_TIMEOUT_MS', { infer: true }) },
      retry: {
        limit: config.get('RAIDERIO_RETRY_LIMIT', { infer: true }),
        methods: ['GET'],
        // 400 is absent on purpose: the runs endpoint answers 400 for a page
        // past the end of the data, and retrying that is three wasted requests
        // for a reply that will not change.
        statusCodes: [408, 429, 500, 502, 503, 504],
        // `Retry-After` is honoured by got's own delay calculation whenever the
        // header is present on a retryable status, which is the only rate-limit
        // signal Raider.io gives — no `X-RateLimit-*` header appears on a
        // success. This caps how long that header may park a request: past it
        // got cancels rather than holding a connection open, and the pass comes
        // back on its own interval instead.
        maxRetryAfter: config.get('RAIDERIO_REQUEST_TIMEOUT_MS', { infer: true }),
      },
      headers: { accept: 'application/json' },
      hooks: {
        beforeRequest: [
          (options) => {
            // Charged per attempt, here rather than once per `get`: this hook
            // runs again for every retry, and a retry is a real request against
            // the per-minute ceiling exactly like a first attempt.
            const consumer = (options.context as { consumer?: RaiderIoConsumer }).consumer;
            this.budget.record(consumer ?? 'other');

            // Added at the last possible moment so the key is in no url this
            // class built, logged or handed to an error.
            options.url?.searchParams.set('access_key', this.accessKey);
          },
        ],
        beforeRetry: [
          (error, retryCount) => {
            this.logger.warn(
              `Retry ${retryCount} for ${this.safe(error.options?.url?.toString())}: ` +
                this.safe(error.message),
            );
          },
        ],
      },
    });
  }

  /**
   * GETs an API path (no leading slash) and returns raw JSON. Callers are
   * expected to validate the payload with a zod schema.
   */
  async get(path: string, options: RaiderIoGetOptions = {}): Promise<unknown> {
    // The url without the key, which is what every message below quotes.
    const url = `${this.baseUrl}/${path.replace(/^\//, '')}`;
    const region = options.region ?? 'global';

    // Paced before the request rather than inside the hook: the hook also runs
    // for retries, and sleeping in it would hold got's own backoff open on top
    // of the wait it has already taken.
    await this.limiter.acquire();
    const startedAt = Date.now();

    try {
      const payload = await this.client
        .get(url, {
          // Captured here, in the caller's async context, and carried to the
          // hook explicitly rather than trusting async local storage to survive
          // the trip through got's internals.
          context: { consumer: raiderIoConsumerFor(currentRunKind()) },
          searchParams: { ...options.searchParams },
        })
        .json<unknown>();

      // Before recording success, because an empty body is not one: Raider.io
      // sits behind Cloudflare, and a front shedding load answers exactly this
      // way. Recording it as healthy traffic is how readiness reports green
      // through an outage.
      if (isEmptyBody(payload)) throw new RaiderIoEmptyResponseError(url);

      this.health.recordSuccess('raiderio', region, Date.now() - startedAt);

      return payload;
    } catch (error) {
      // Attempts, not retries: at LOG_LEVEL=error the per-retry warnings are
      // suppressed, so without this a one-shot failure and an exhausted
      // four-attempt failure read identically.
      const attempts = attemptsSpent(error);

      if (error instanceof HTTPError) {
        const status = error.response.statusCode;
        this.health.recordFailure('raiderio', region, `HTTP ${status} for ${url}`, status);

        throw new RaiderIoApiError(
          status,
          url,
          `Raider.io API ${status} for ${url} after ${attempts} ` +
            `${attempts === 1 ? 'attempt' : 'attempts'}: ${this.safe(error.message)}`,
          { cause: error, attempts },
        );
      }

      const reason = this.safe(error instanceof Error ? error.message : String(error));
      this.health.recordFailure('raiderio', region, `${reason} for ${url}`);

      if (error instanceof Error) {
        error.message =
          `${this.safe(error.message)} ` +
          `(${attempts} ${attempts === 1 ? 'attempt' : 'attempts'} for ${url})`;
      }

      throw error;
    }
  }

  /** Strips the access key from anything got built rather than this class. */
  private safe(value: string | undefined): string {
    return value ? this.health.redact(value) : 'unknown url';
  }
}
