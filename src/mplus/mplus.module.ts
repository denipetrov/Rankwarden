import { Module } from '@nestjs/common';

import { MplusRepresentationModule } from '../mplus-representation/mplus-representation.module.js';
import { MplusSeasonModule } from '../mplus-season/mplus-season.module.js';
import { RaiderIoModule } from '../raiderio/raiderio.module.js';
import { MplusRepository } from './mplus.repository.js';
import { MplusScheduler } from './mplus.scheduler.js';
import { MplusService } from './mplus.service.js';

@Module({
  imports: [RaiderIoModule, MplusSeasonModule, MplusRepresentationModule],
  providers: [MplusRepository, MplusService, MplusScheduler],
  exports: [MplusService, MplusRepository],
})
export class MplusModule {}
