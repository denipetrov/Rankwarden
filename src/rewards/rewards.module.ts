import { Module } from '@nestjs/common';

import { BlizzardModule } from '../blizzard/blizzard.module.js';
import { SeasonRewardsService } from './season-rewards.service.js';

/**
 * Season titles and their rating cutoffs, for the archive and the live season
 * alike. One provider, so the spec lookups it caches are shared by both.
 */
@Module({
  imports: [BlizzardModule],
  providers: [SeasonRewardsService],
  exports: [SeasonRewardsService],
})
export class RewardsModule {}
