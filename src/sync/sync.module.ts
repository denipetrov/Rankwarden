import { Module } from '@nestjs/common';

import { LeaderboardModule } from '../leaderboard/leaderboard.module.js';
import { MplusModule } from '../mplus/mplus.module.js';
import { CharacterSyncController } from './character-sync.controller.js';
import { CharacterSyncService } from './character-sync.service.js';
import { MplusCharacterSyncController } from './mplus-character-sync.controller.js';
import { MplusCharacterSyncService } from './mplus-character-sync.service.js';

@Module({
  imports: [LeaderboardModule, MplusModule],
  controllers: [CharacterSyncController, MplusCharacterSyncController],
  providers: [CharacterSyncService, MplusCharacterSyncService],
})
export class SyncModule {}
