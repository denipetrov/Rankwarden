import { Global, Module } from '@nestjs/common';

import { SweepEvents } from './events/sweep-events.service.js';
import { DependencyHealth } from './health/dependency-health.service.js';
import { IngestionCoordinator } from './ingestion-coordinator.service.js';
import { QuotaBudget } from './quota/quota-budget.service.js';
import { RaiderIoBudget } from './quota/raiderio-budget.service.js';
import { RaiderIoBudgetStore } from './quota/raiderio-budget.store.js';

@Global()
@Module({
  providers: [
    SweepEvents,
    IngestionCoordinator,
    DependencyHealth,
    QuotaBudget,
    RaiderIoBudget,
    RaiderIoBudgetStore,
  ],
  exports: [SweepEvents, IngestionCoordinator, DependencyHealth, QuotaBudget, RaiderIoBudget],
})
export class CommonModule {}
