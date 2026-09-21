import { Module } from '@nestjs/common';

import { MplusModule } from '../mplus/mplus.module.js';
import { MplusRepresentationModule } from '../mplus-representation/mplus-representation.module.js';
import { MplusSeasonModule } from '../mplus-season/mplus-season.module.js';
import { RaiderIoModule } from '../raiderio/raiderio.module.js';
import { MplusArchiveRepository } from './mplus-archive.repository.js';
import { MplusArchiveScheduler } from './mplus-archive.scheduler.js';
import { MplusArchiveService } from './mplus-archive.service.js';

@Module({
  // MplusModule for the affix catalogue, which live and archived runs share;
  // MplusSeasonModule for the season catalogue the backlog is worked from.
  imports: [RaiderIoModule, MplusModule, MplusSeasonModule, MplusRepresentationModule],
  providers: [MplusArchiveRepository, MplusArchiveService, MplusArchiveScheduler],
  exports: [MplusArchiveService],
})
export class MplusArchiveModule {}
