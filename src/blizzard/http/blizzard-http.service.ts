import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import got, { HTTPError, RequestError, type Got } from 'got';

import { DependencyHealth } from '../../common/health/dependency-health.service.js';
import type { Env } from '../../config/env.schema.js';
import { apiHost, namespaceFor, type NamespaceKind, type Region } from '../blizzard.constants.js';
import { BLIZZARD_TOKEN_PROVIDER, type BlizzardTokenProvider } from '../auth/token-provider.js';
import { BlizzardApiError } from './blizzard-api.error.js';

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

  constructor(
    config: ConfigService<Env, true>,
    @Inject(BLIZZARD_TOKEN_PROVIDER) private readonly tokens: BlizzardTokenProvider,
    private readonly health: DependencyHealth,
  ) {
    this.locale = config.get('BLIZZARD_LOCALE', { infer: true });
    this.hostTemplate = config.get('BLIZZARD_API_HOST_TEMPLATE', { infer: true });

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
      const payload = await this.client
        .get(url, {
          searchParams: {
            namespace: namespaceFor(options.namespace ?? 'dynamic', region),
            locale: this.locale,
            ...options.searchParams,
          },
        })
        .json<unknown>();

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
