import { Module } from '@nestjs/common';

import { BlizzardModule } from '../blizzard/blizzard.module.js';
import { SeasonScheduler } from './season.scheduler.js';
import { SeasonService } from './season.service.js';

@Module({
  imports: [BlizzardModule],
  providers: [SeasonService, SeasonScheduler],
  exports: [SeasonService],
})
export class SeasonModule {}
