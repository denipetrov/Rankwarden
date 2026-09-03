import { Global, Module } from '@nestjs/common';

import { SweepEvents } from './events/sweep-events.service.js';

@Global()
@Module({
  providers: [SweepEvents],
  exports: [SweepEvents],
})
export class CommonModule {}
