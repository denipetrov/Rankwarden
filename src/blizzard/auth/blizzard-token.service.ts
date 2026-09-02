import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { getAccessToken, validateToken, type BlizzardAuthConfig } from '@denipetrov/blizz-auth';

import type { Env } from '../../config/env.schema.js';
import type { BlizzardTokenProvider } from './token-provider.js';

/**
 * Adapter over @denipetrov/blizz-auth. The package owns caching (per
 * region + client id, refreshed 60s before expiry), so this service only binds
 * the validated env to it and exposes the provider seam the HTTP layer injects.
 */
@Injectable()
export class BlizzardTokenService implements BlizzardTokenProvider, OnModuleInit {
  private readonly logger = new Logger(BlizzardTokenService.name);
  private readonly credentials: BlizzardAuthConfig;

  constructor(config: ConfigService<Env, true>) {
    this.credentials = {
      clientId: config.get('BLIZZARD_CLIENT_ID', { infer: true }),
      clientSecret: config.get('BLIZZARD_CLIENT_SECRET', { infer: true }),
      region: config.get('BLIZZARD_REGION', { infer: true }),
    };
  }

  /** Fail fast at boot rather than on the first leaderboard request. */
  async onModuleInit(): Promise<void> {
    const result = await validateToken(await this.getAccessToken(), this.credentials);

    if (!result.valid) {
      throw new Error(
        `Blizzard OAuth token rejected (${result.error.code}): ${result.error.message}`,
      );
    }

    this.logger.log(
      `Blizzard OAuth ready for client ${result.clientId} via ${this.credentials.region}`,
    );
  }

  getAccessToken(): Promise<string> {
    return getAccessToken(this.credentials);
  }
}
