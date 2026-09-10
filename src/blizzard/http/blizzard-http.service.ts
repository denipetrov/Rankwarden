import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import got, { HTTPError, RequestError, type Got } from 'got';

import { DependencyHealth } from '../../common/health/dependency-health.service.js';
import { currentRunKind } from '../../common/logging/run-context.js';
import {
  QuotaBudget,
  quotaConsumerFor,
  type QuotaConsumer,
} from '../../common/quota/quota-budget.service.js';
import type { Env } from '../../config/env.schema.js';
import { apiHost, namespaceFor, type NamespaceKind, type Region } from '../blizzard.constants.js';
import { BLIZZARD_TOKEN_PROVIDER, type BlizzardTokenProvider } from '../auth/token-provider.js';
import { BlizzardApiError, BlizzardEmptyResponseError } from './blizzard-api.error.js';

/**
 * Whether a parsed body carries nothing at all.
 *
 * `got` resolves an empty body to `''` rather than raising a parse error, so
 * without this check the emptiness travels one layer up and only fails at the
 * zod boundary — where it is indistinguishable from a payload Blizzard shaped
 * wrongly, and gets classified as permanent. Every Game Data endpoint returns a
 * JSON object, so nothing legitimate lands here.
 */
function isEmptyBody(payload: unknown): boolean {
  return payload === '' || payload === null || payload === undefined;
}

/** Requests actually spent on a failure — got counts retries from zero. */
function attemptsSpent(error: unknown): number {
  return error instanceof RequestError ? (error.request?.retryCount ?? 0) + 1 : 1;
}

export interface BlizzardGetOptions {
  /** Extra query parameters merged after namespace/locale. */
  searchParams?: Record<string, string | number>;
  /** Defaults to the dynamic namespace used by season and leaderboard data. */
  namespace?: NamespaceKind;
}

/**
 * Single got instance shared by every Blizzard call: bearer auth, retries with
 * backoff, and the namespace/locale query pair every Game Data endpoint needs.
 */
@Injectable()
export class BlizzardHttpService {
  private readonly logger = new Logger(BlizzardHttpService.name);
  private readonly client: Got;
  private readonly locale: string;
  private readonly hostTemplate: string;
  private readonly profileRetryLimit: number;

  constructor(
    config: ConfigService<Env, true>,
    @Inject(BLIZZARD_TOKEN_PROVIDER) private readonly tokens: BlizzardTokenProvider,
    private readonly health: DependencyHealth,
    private readonly budget: QuotaBudget,
  ) {
    this.locale = config.get('BLIZZARD_LOCALE', { infer: true });
    this.hostTemplate = config.get('BLIZZARD_API_HOST_TEMPLATE', { infer: true });
    this.profileRetryLimit = config.get('PROFILE_RETRY_LIMIT', { infer: true });

    this.client = got.extend({
      timeout: { request: config.get('BLIZZARD_REQUEST_TIMEOUT_MS', { infer: true }) },
      retry: {
        limit: config.get('BLIZZARD_RETRY_LIMIT', { infer: true }),
        methods: ['GET'],
        statusCodes: [408, 429, 500, 502, 503, 504],
      },
      headers: { accept: 'application/json' },
      hooks: {
        beforeRequest: [
          async (options) => {
            // Charged per attempt, here rather than once per `get`: this hook
            // runs again for every retry, and Blizzard counts retries against
            // the quota exactly like first attempts.
            const consumer = (options.context as { consumer?: QuotaConsumer }).consumer;
            this.budget.record(consumer ?? 'other');

            const token = await this.tokens.getAccessToken();
            options.headers.authorization = `Bearer ${token}`;
          },
        ],
        beforeRetry: [
          (error, retryCount) => {
            this.logger.warn(
              `Retry ${retryCount} for ${error.options?.url?.toString() ?? 'unknown url'}: ${error.message}`,
            );
          },
        ],
      },
    });
  }

  /**
   * GETs a Game Data path (no leading slash) for a region and returns raw JSON.
   * Callers are expected to validate the payload with a zod schema.
   */
  async get(region: Region, path: string, options: BlizzardGetOptions = {}): Promise<unknown> {
    const url = `${apiHost(region, this.hostTemplate)}/${path.replace(/^\//, '')}`;
    const startedAt = Date.now();

    try {
      const namespace = options.namespace ?? 'dynamic';

      const payload = await this.client
        .get(url, {
          // Captured here, in the caller's async context, and carried to the
          // hook explicitly rather than trusting async local storage to survive
          // the trip through got's internals.
          context: { consumer: quotaConsumerFor(currentRunKind()) },
          // Per-character endpoints retry less than everything else. There are
          // ~332 ladder fetches in a sweep and one profile fetch per character
          // on the ladders, so the same retry budget means very different
          // things: see PROFILE_RETRY_LIMIT for the arithmetic.
          ...(namespace === 'profile' ? { retry: { limit: this.profileRetryLimit } } : {}),
          searchParams: {
            namespace: namespaceFor(namespace, region),
            locale: this.locale,
            ...options.searchParams,
          },
        })
        .json<unknown>();

      // Before recording success, because an empty body is not one: a gateway
      // shedding load answers 200 with nothing, and readiness should see that
      // as the outage it is rather than as healthy traffic.
      if (isEmptyBody(payload)) throw new BlizzardEmptyResponseError(url);

      this.health.recordBlizzardSuccess(region, Date.now() - startedAt);

      return payload;
    } catch (error) {
      // Attempts, not retries: at LOG_LEVEL=error the per-retry warnings are
      // suppressed, so without this a one-shot failure and an exhausted
      // four-attempt failure read identically.
      const attempts = attemptsSpent(error);

      if (error instanceof HTTPError) {
        const status = error.response.statusCode;
        this.health.recordBlizzardFailure(region, `HTTP ${status} for ${url}`, status);

        throw new BlizzardApiError(
          status,
          url,
          `Blizzard API ${status} for ${url} after ${attempts} ` +
            `${attempts === 1 ? 'attempt' : 'attempts'}: ${error.message}`,
          { cause: error, attempts },
        );
      }

      const reason = error instanceof Error ? error.message : String(error);
      this.health.recordBlizzardFailure(region, `${reason} for ${url}`);

      if (error instanceof Error) {
        error.message = `${error.message} (${attempts} ${attempts === 1 ? 'attempt' : 'attempts'} for ${url})`;
      }

      throw error;
    }
  }
}
