import { Module } from '@nestjs/common';

import { RaiderIoModule } from '../raiderio/raiderio.module.js';
import { MplusSeasonService } from './mplus-season.service.js';
import { MplusRepository } from './mplus.repository.js';
import { MplusScheduler } from './mplus.scheduler.js';
import { MplusService } from './mplus.service.js';

@Module({
  imports: [RaiderIoModule],
  providers: [MplusRepository, MplusSeasonService, MplusService, MplusScheduler],
  exports: [MplusService, MplusSeasonService, MplusRepository],
})
export class MplusModule {}
