import { Module } from '@nestjs/common';

import { ArchiveModule } from '../archive/archive.module.js';
import { LeaderboardModule } from '../leaderboard/leaderboard.module.js';
import { MplusModule } from '../mplus/mplus.module.js';
import { MplusArchiveModule } from '../mplus-archive/mplus-archive.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { RepresentationModule } from '../representation/representation.module.js';
import { SeasonModule } from '../season/season.module.js';
import { AdminController } from './admin.controller.js';

@Module({
  imports: [
    LeaderboardModule,
    ProfileModule,
    RepresentationModule,
    ArchiveModule,
    SeasonModule,
    MplusModule,
    MplusArchiveModule,
  ],
  controllers: [AdminController],
})
export class AdminModule {}
