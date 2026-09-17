import { Module } from '@nestjs/common';

import { LeaderboardModule } from '../leaderboard/leaderboard.module.js';
import { MplusModule } from '../mplus/mplus.module.js';
import { MplusArchiveModule } from '../mplus-archive/mplus-archive.module.js';
import { MplusSeasonModule } from '../mplus-season/mplus-season.module.js';
import { SeasonModule } from '../season/season.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [SeasonModule, LeaderboardModule, MplusModule, MplusSeasonModule, MplusArchiveModule],
  controllers: [HealthController],
})
export class HealthModule {}
