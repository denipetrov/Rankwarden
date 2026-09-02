import { Module } from '@nestjs/common';

import { LeaderboardModule } from '../leaderboard/leaderboard.module.js';
import { SeasonModule } from '../season/season.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [SeasonModule, LeaderboardModule],
  controllers: [HealthController],
})
export class HealthModule {}
