import { Module } from '@nestjs/common';

import { MplusSeasonModule } from '../mplus-season/mplus-season.module.js';
import { RaiderIoModule } from '../raiderio/raiderio.module.js';
import { MplusRepository } from './mplus.repository.js';
import { MplusScheduler } from './mplus.scheduler.js';
import { MplusService } from './mplus.service.js';

@Module({
  imports: [RaiderIoModule, MplusSeasonModule],
  providers: [MplusRepository, MplusService, MplusScheduler],
  exports: [MplusService, MplusRepository],
})
export class MplusModule {}
