import { Module } from '@nestjs/common';

import { LeaderboardModule } from '../leaderboard/leaderboard.module.js';
import { CharacterSyncController } from './character-sync.controller.js';
import { CharacterSyncService } from './character-sync.service.js';

@Module({
  imports: [LeaderboardModule],
  controllers: [CharacterSyncController],
  providers: [CharacterSyncService],
})
export class SyncModule {}
