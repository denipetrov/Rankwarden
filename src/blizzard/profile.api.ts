import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { fillPath } from '../common/utils/path-template.js';
import type { Env } from '../config/env.schema.js';
import type { Region } from './blizzard.constants.js';
import { BlizzardApiError } from './http/blizzard-api.error.js';
import { BlizzardHttpService } from './http/blizzard-http.service.js';
import {
  characterProfileSchema,
  characterSpecializationsSchema,
  type CharacterProfilePayload,
  type CharacterSpecializationsPayload,
} from './schemas/character-profile.schema.js';

/**
 * Typed access to the per-character profile endpoints.
 *
 * Endpoint paths come from configuration (`BLIZZARD_PATH_*`), not from here.
 */
@Injectable()
export class ProfileApi {
  private readonly logger = new Logger(ProfileApi.name);

  private readonly profilePath: string;
  private readonly specializationsPath: string;

  constructor(
    private readonly http: BlizzardHttpService,
    config: ConfigService<Env, true>,
  ) {
    this.profilePath = config.get('BLIZZARD_PATH_CHARACTER_PROFILE', { infer: true });
    this.specializationsPath = config.get('BLIZZARD_PATH_CHARACTER_SPECIALIZATIONS', {
      infer: true,
    });
  }

  /**
   * Character names are case-insensitive in the API but must be lowercased and
   * percent-encoded — ladders are full of names like "Zëph".
   */
  private path(template: string, realmSlug: string, characterName: string): string {
    return fillPath(template, {
      realmSlug,
      characterName: encodeURIComponent(characterName.toLowerCase()),
    });
  }

  /** Resolves to null when the character no longer exists (renamed, transferred, deleted). */
  async getProfile(
    region: Region,
    realmSlug: string,
    characterName: string,
  ): Promise<CharacterProfilePayload | null> {
    return this.fetch(
      region,
      this.path(this.profilePath, realmSlug, characterName),
      characterProfileSchema.parse,
    );
  }

  async getSpecializations(
    region: Region,
    realmSlug: string,
    characterName: string,
  ): Promise<CharacterSpecializationsPayload | null> {
    return this.fetch(
      region,
      this.path(this.specializationsPath, realmSlug, characterName),
      characterSpecializationsSchema.parse,
    );
  }

  private async fetch<T>(region: Region, path: string, parse: (input: unknown) => T) {
    try {
      return parse(await this.http.get(region, path, { namespace: 'profile' }));
    } catch (error) {
      if (error instanceof BlizzardApiError && error.isNotFound) {
        this.logger.debug(`No such character: ${region}/${path}`);
        return null;
      }
      throw error;
    }
  }
}
