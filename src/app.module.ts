import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { CommonModule } from './common/common.module.js';
import { AppConfigModule } from './config/config.module.js';
import { DatabaseModule } from './database/database.module.js';
import { BlizzardModule } from './blizzard/blizzard.module.js';
import { SeasonModule } from './season/season.module.js';
import { LeaderboardModule } from './leaderboard/leaderboard.module.js';
import { ProfileModule } from './profile/profile.module.js';
import { ArchiveModule } from './archive/archive.module.js';
import { RepresentationModule } from './representation/representation.module.js';
import { SyncModule } from './sync/sync.module.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    AppConfigModule,
    CommonModule,
    ScheduleModule.forRoot(),
    DatabaseModule,
    BlizzardModule,
    SeasonModule,
    LeaderboardModule,
    ProfileModule,
    RepresentationModule,
    ArchiveModule,
    SyncModule,
    HealthModule,
  ],
})
export class AppModule {}
