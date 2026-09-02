import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { AppConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { BlizzardModule } from './blizzard/blizzard.module.js';
import { SeasonModule } from './season/season.module.js';
import { LeaderboardModule } from './leaderboard/leaderboard.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    AppConfigModule,
    ScheduleModule.forRoot(),
    DatabaseModule,
    BlizzardModule,
    SeasonModule,
    LeaderboardModule,
    HealthModule,
  ],
})
export class AppModule {}
