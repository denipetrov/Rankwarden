import { Global, Module } from '@nestjs/common';

import { SweepEvents } from './events/sweep-events.service.js';
import { DependencyHealth } from './health/dependency-health.service.js';
import { IngestionCoordinator } from './ingestion-coordinator.service.js';

@Global()
@Module({
  providers: [SweepEvents, IngestionCoordinator, DependencyHealth],
  exports: [SweepEvents, IngestionCoordinator, DependencyHealth],
})
export class CommonModule {}
