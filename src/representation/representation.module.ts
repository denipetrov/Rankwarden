import { Module } from '@nestjs/common';
import { REPRESENTATION_MIN_RATINGS } from '@denipetrov/spirit-link/constants';

import { SeasonModule } from '../season/season.module.js';
import { REPRESENTATION_CUTOFFS } from './representation.constants.js';
import { SpecRepresentationScheduler } from './spec-representation.scheduler.js';
import { SpecRepresentationService } from './spec-representation.service.js';

@Module({
  imports: [SeasonModule],
  providers: [
    { provide: REPRESENTATION_CUTOFFS, useValue: REPRESENTATION_MIN_RATINGS },
    SpecRepresentationService,
    SpecRepresentationScheduler,
  ],
  exports: [SpecRepresentationService],
})
export class RepresentationModule {}
