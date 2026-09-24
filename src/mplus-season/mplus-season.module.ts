import { Module } from '@nestjs/common';

import { RaiderIoModule } from '../raiderio/raiderio.module.js';
import { MplusCatalogueRepository } from './mplus-catalogue.repository.js';
import { MplusCatalogueService } from './mplus-catalogue.service.js';
import { MplusCutoffsService } from './mplus-cutoffs.service.js';
import { MplusSeasonEvents } from './mplus-season-events.service.js';
import { MplusSeasonStateRepository } from './mplus-season-state.repository.js';
import { MplusSeasonTransitionScheduler } from './mplus-season-transition.scheduler.js';
import { MplusSeasonTransitionService } from './mplus-season-transition.service.js';
import { MplusSeasonScheduler } from './mplus-season.scheduler.js';
import { MplusSeasonService } from './mplus-season.service.js';

/**
 * Mythic+ seasons: the catalogue, which season is current in each region, and
 * retiring a season once its successor opens. The counterpart of `SeasonModule`.
 *
 * Its own module because both Mythic+ jobs depend on it — the live pass for the
 * current season, the archive for the list of finished ones — and the archive
 * module already imports the live one.
 */
@Module({
  imports: [RaiderIoModule],
  providers: [
    MplusCatalogueRepository,
    MplusCatalogueService,
    MplusCutoffsService,
    MplusSeasonStateRepository,
    MplusSeasonEvents,
    MplusSeasonService,
    MplusSeasonScheduler,
    MplusSeasonTransitionService,
    MplusSeasonTransitionScheduler,
  ],
  exports: [
    MplusCatalogueRepository,
    MplusCatalogueService,
    MplusCutoffsService,
    MplusSeasonEvents,
    MplusSeasonService,
    MplusSeasonStateRepository,
    MplusSeasonTransitionService,
  ],
})
export class MplusSeasonModule {}
