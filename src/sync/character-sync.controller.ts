import { Body, Controller, HttpCode, HttpStatus, Post, UsePipes } from '@nestjs/common';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import { CharacterSyncService, type CharacterSyncResult } from './character-sync.service.js';
import { characterSyncSchema, type CharacterSyncInput } from './dto/character-sync.dto.js';

@Controller('characters')
export class CharacterSyncController {
  constructor(private readonly sync: CharacterSyncService) {}

  /**
   * Accepts a whole character record and writes it to `characters` plus the two
   * per-spec ratings collections.
   *
   * 404 if no such character is tracked, 409 while a ladder sweep is running.
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(characterSyncSchema))
  syncCharacter(@Body() body: CharacterSyncInput): Promise<CharacterSyncResult> {
    return this.sync.sync(body);
  }
}
