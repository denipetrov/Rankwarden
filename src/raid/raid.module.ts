import { Module } from '@nestjs/common';

import { RaiderIoModule } from '../raiderio/raiderio.module.js';
import { RaidCatalogueRepository } from './raid-catalogue.repository.js';
import { RaidCatalogueScheduler } from './raid-catalogue.scheduler.js';
import { RaidCatalogueService } from './raid-catalogue.service.js';

/**
 * Raiding, from Raider.io. Today the catalogue only: every raid and its
 * encounters, which is what the raiding endpoints are asked by.
 */
@Module({
  imports: [RaiderIoModule],
  providers: [RaidCatalogueRepository, RaidCatalogueService, RaidCatalogueScheduler],
  exports: [RaidCatalogueRepository, RaidCatalogueService],
})
export class RaidModule {}
