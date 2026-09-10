import { Global, Module } from '@nestjs/common';

import { SweepEvents } from './events/sweep-events.service.js';
import { DependencyHealth } from './health/dependency-health.service.js';
import { IngestionCoordinator } from './ingestion-coordinator.service.js';
import { QuotaBudget } from './quota/quota-budget.service.js';

@Global()
@Module({
  providers: [SweepEvents, IngestionCoordinator, DependencyHealth, QuotaBudget],
  exports: [SweepEvents, IngestionCoordinator, DependencyHealth, QuotaBudget],
})
export class CommonModule {}
