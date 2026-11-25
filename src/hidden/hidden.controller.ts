import { Body, Controller, HttpCode, HttpStatus, Post, UsePipes } from '@nestjs/common';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { setHiddenSchema, type SetHiddenInput } from './dto/set-hidden.dto.js';
import { HiddenRegistry } from './hidden.registry.js';

export type SetHiddenResult = SetHiddenInput & {
  /** Stored documents the change reached now; later writes follow the list. */
  updated: { characters: number; mplusCharacters: number } | { guilds: number };
};

@Controller('hidden')
export class HiddenController {
  constructor(private readonly registry: HiddenRegistry) {}

  /**
   * Marks a player or a guild hidden or visible. Idempotent.
   *
   * Never a 404: a player or guild not stored yet is recorded all the same,
   * and comes in hidden when a ladder or board first lists them.
   */
  @Post()
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(setHiddenSchema))
  async setHidden(@Body() body: SetHiddenInput): Promise<SetHiddenResult> {
    const updated =
      body.kind === 'character'
        ? await this.registry.setCharacterHidden(
            body.region,
            body.realmSlug,
            body.name,
            body.hidden,
          )
        : await this.registry.setGuildHidden(body.guildId, body.hidden);

    return { ...body, updated };
  }
}
