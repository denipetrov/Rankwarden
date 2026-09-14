import { Body, Controller, HttpCode, HttpStatus, Post, UsePipes } from '@nestjs/common';

import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe.js';
import {
  MplusCharacterSyncService,
  type MplusCharacterSyncResult,
} from './mplus-character-sync.service.js';
import {
  mplusCharacterSyncSchema,
  type MplusCharacterSyncInput,
} from './dto/mplus-character-sync.dto.js';

@Controller('mplus/characters')
export class MplusCharacterSyncController {
  constructor(private readonly sync: MplusCharacterSyncService) {}

  /**
   * Merges a Mythic+ character record into `mplus_characters`.
   *
   * 404 if no such character is tracked, 409 while a Mythic+ pass is running.
   */
  @Post('sync')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ZodValidationPipe(mplusCharacterSyncSchema))
  syncCharacter(@Body() body: MplusCharacterSyncInput): Promise<MplusCharacterSyncResult> {
    return this.sync.sync(body);
  }
}
