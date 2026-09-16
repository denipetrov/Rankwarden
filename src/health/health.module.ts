import { Module } from '@nestjs/common';

import { LeaderboardModule } from '../leaderboard/leaderboard.module.js';
import { MplusModule } from '../mplus/mplus.module.js';
import { MplusArchiveModule } from '../mplus-archive/mplus-archive.module.js';
import { SeasonModule } from '../season/season.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [SeasonModule, LeaderboardModule, MplusModule, MplusArchiveModule],
  controllers: [HealthController],
})
export class HealthModule {}
