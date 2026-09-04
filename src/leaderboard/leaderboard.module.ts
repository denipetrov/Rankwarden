import { Module } from '@nestjs/common';

import { BlizzardModule } from '../blizzard/blizzard.module.js';
import { SeasonModule } from '../season/season.module.js';
import { CharacterRepository } from './character.repository.js';
import { RatingRepository } from './rating.repository.js';
import { LeaderboardScheduler } from './leaderboard.scheduler.js';
import { LeaderboardService } from './leaderboard.service.js';

@Module({
  imports: [BlizzardModule, SeasonModule],
  providers: [LeaderboardService, CharacterRepository, RatingRepository, LeaderboardScheduler],
  exports: [LeaderboardService, CharacterRepository, RatingRepository],
})
export class LeaderboardModule {}
