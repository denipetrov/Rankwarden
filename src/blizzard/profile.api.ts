import { Injectable, Logger } from '@nestjs/common';

import type { Region } from './blizzard.constants.js';
import { BlizzardApiError } from './http/blizzard-api.error.js';
import { BlizzardHttpService } from './http/blizzard-http.service.js';
import {
  characterProfileSchema,
  characterSpecializationsSchema,
  type CharacterProfilePayload,
  type CharacterSpecializationsPayload,
} from './schemas/character-profile.schema.js';

/** Typed access to the per-character profile endpoints. */
@Injectable()
export class ProfileApi {
  private readonly logger = new Logger(ProfileApi.name);

  constructor(private readonly http: BlizzardHttpService) {}

  /**
   * Character names are case-insensitive in the API but must be lowercased and
   * percent-encoded — ladders are full of names like "Zëph".
   */
  private path(realmSlug: string, characterName: string, suffix = ''): string {
    const name = encodeURIComponent(characterName.toLowerCase());
    return `profile/wow/character/${realmSlug}/${name}${suffix}`;
  }

  /** Resolves to null when the character no longer exists (renamed, transferred, deleted). */
  async getProfile(
    region: Region,
    realmSlug: string,
    characterName: string,
  ): Promise<CharacterProfilePayload | null> {
    return this.fetch(region, this.path(realmSlug, characterName), characterProfileSchema.parse);
  }

  async getSpecializations(
    region: Region,
    realmSlug: string,
    characterName: string,
  ): Promise<CharacterSpecializationsPayload | null> {
    return this.fetch(
      region,
      this.path(realmSlug, characterName, '/specializations'),
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
