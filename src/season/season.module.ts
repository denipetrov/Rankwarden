import { Module } from '@nestjs/common';

import { BlizzardModule } from '../blizzard/blizzard.module.js';
import { SeasonEvents } from './season-events.service.js';
import { SeasonScheduler } from './season.scheduler.js';
import { SeasonService } from './season.service.js';
import { SeasonStateRepository } from './season-state.repository.js';
import { SeasonTransitionScheduler } from './season-transition.scheduler.js';
import { SeasonTransitionService } from './season-transition.service.js';

@Module({
  imports: [BlizzardModule],
  providers: [
    SeasonService,
    SeasonScheduler,
    SeasonEvents,
    SeasonStateRepository,
    SeasonTransitionService,
    SeasonTransitionScheduler,
  ],
  exports: [SeasonService, SeasonEvents, SeasonStateRepository, SeasonTransitionService],
})
export class SeasonModule {}
