import { Module } from '@nestjs/common';

import { BlizzardModule } from '../blizzard/blizzard.module.js';
import { LeaderboardModule } from '../leaderboard/leaderboard.module.js';
import { ProfileEnrichmentService } from './profile-enrichment.service.js';
import { ProfileScheduler } from './profile.scheduler.js';

@Module({
  imports: [BlizzardModule, LeaderboardModule],
  providers: [ProfileEnrichmentService, ProfileScheduler],
  exports: [ProfileEnrichmentService],
})
export class ProfileModule {}
