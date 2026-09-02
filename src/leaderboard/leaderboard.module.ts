import { Module } from '@nestjs/common';

import { BlizzardModule } from '../blizzard/blizzard.module.js';
import { SeasonModule } from '../season/season.module.js';
import { LeaderboardRepository } from './leaderboard.repository.js';
import { LeaderboardScheduler } from './leaderboard.scheduler.js';
import { LeaderboardService } from './leaderboard.service.js';

@Module({
  imports: [BlizzardModule, SeasonModule],
  providers: [LeaderboardService, LeaderboardRepository, LeaderboardScheduler],
  exports: [LeaderboardService],
})
export class LeaderboardModule {}
