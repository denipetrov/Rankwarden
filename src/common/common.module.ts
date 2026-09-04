import { Global, Module } from '@nestjs/common';

import { SweepEvents } from './events/sweep-events.service.js';
import { IngestionCoordinator } from './ingestion-coordinator.service.js';

@Global()
@Module({
  providers: [SweepEvents, IngestionCoordinator],
  exports: [SweepEvents, IngestionCoordinator],
})
export class CommonModule {}
