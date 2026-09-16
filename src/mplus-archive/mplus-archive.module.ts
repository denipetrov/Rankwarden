import { Module } from '@nestjs/common';

import { MplusModule } from '../mplus/mplus.module.js';
import { RaiderIoModule } from '../raiderio/raiderio.module.js';
import { MplusArchiveRepository } from './mplus-archive.repository.js';
import { MplusArchiveScheduler } from './mplus-archive.scheduler.js';
import { MplusArchiveService } from './mplus-archive.service.js';
import { MplusCatalogueService } from './mplus-catalogue.service.js';

@Module({
  // MplusModule for the affix catalogue, which live and archived runs share.
  imports: [RaiderIoModule, MplusModule],
  providers: [
    MplusArchiveRepository,
    MplusCatalogueService,
    MplusArchiveService,
    MplusArchiveScheduler,
  ],
  exports: [MplusArchiveService, MplusCatalogueService],
})
export class MplusArchiveModule {}
