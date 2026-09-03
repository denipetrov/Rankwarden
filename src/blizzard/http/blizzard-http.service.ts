import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import got, { HTTPError, type Got } from 'got';

import type { Env } from '../../config/env.schema.js';
import { apiHost, namespaceFor, type NamespaceKind, type Region } from '../blizzard.constants.js';
import { BLIZZARD_TOKEN_PROVIDER, type BlizzardTokenProvider } from '../auth/token-provider.js';
import { BlizzardApiError } from './blizzard-api.error.js';

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

  constructor(
    config: ConfigService<Env, true>,
    @Inject(BLIZZARD_TOKEN_PROVIDER) private readonly tokens: BlizzardTokenProvider,
  ) {
    this.locale = config.get('BLIZZARD_LOCALE', { infer: true });

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
    const url = `${apiHost(region)}/${path.replace(/^\//, '')}`;

    try {
      return await this.client
        .get(url, {
          searchParams: {
            namespace: namespaceFor(options.namespace ?? 'dynamic', region),
            locale: this.locale,
            ...options.searchParams,
          },
        })
        .json<unknown>();
    } catch (error) {
      if (error instanceof HTTPError) {
        throw new BlizzardApiError(
          error.response.statusCode,
          url,
          `Blizzard API ${error.response.statusCode} for ${url}: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}
