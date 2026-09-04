import { Module } from '@nestjs/common';

import { SeasonModule } from '../season/season.module.js';
import { SpecRepresentationScheduler } from './spec-representation.scheduler.js';
import { SpecRepresentationService } from './spec-representation.service.js';

@Module({
  imports: [SeasonModule],
  providers: [SpecRepresentationService, SpecRepresentationScheduler],
  exports: [SpecRepresentationService],
})
export class RepresentationModule {}
