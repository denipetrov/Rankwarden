import { Module } from '@nestjs/common';

import { RaiderIoModule } from '../raiderio/raiderio.module.js';
import { GuildRepository } from './guild.repository.js';
import { RaidCatalogueRepository } from './raid-catalogue.repository.js';
import { RaidCatalogueScheduler } from './raid-catalogue.scheduler.js';
import { RaidCatalogueService } from './raid-catalogue.service.js';
import { RaidRankingsRepository } from './raid-rankings.repository.js';
import { RaidRankingsScheduler } from './raid-rankings.scheduler.js';
import { RaidRankingsService } from './raid-rankings.service.js';

/**
 * Raiding, from Raider.io: the catalogue of every raid and its encounters, and
 * on each raid the guilds ranked on it, described once each in `guilds`.
 */
@Module({
  imports: [RaiderIoModule],
  providers: [
    RaidCatalogueRepository,
    RaidCatalogueService,
    RaidCatalogueScheduler,
    GuildRepository,
    RaidRankingsRepository,
    RaidRankingsService,
    RaidRankingsScheduler,
  ],
  exports: [RaidCatalogueRepository, RaidCatalogueService, GuildRepository, RaidRankingsService],
})
export class RaidModule {}
