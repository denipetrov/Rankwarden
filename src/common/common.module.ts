import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DependencyHealthModule } from '@denipetrov/spirit-link/health';

import type { Env } from '../config/env.schema.js';
import { SweepEvents } from './events/sweep-events.service.js';
import { healthSecrets } from './health/upstream-provider.js';
import { IngestionCoordinator } from './ingestion-coordinator.service.js';
import { QuotaBudget } from './quota/quota-budget.service.js';
import { RaiderIoBudget } from './quota/raiderio-budget.service.js';
import { RaiderIoBudgetStore } from './quota/raiderio-budget.store.js';

@Global()
@Module({
  imports: [
    // One shared tracker for the whole application: the HTTP clients write to
    // it and the health controller reads from it.
    DependencyHealthModule.forRootAsync({
      isGlobal: true,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({ secrets: healthSecrets(config) }),
    }),
  ],
  providers: [SweepEvents, IngestionCoordinator, QuotaBudget, RaiderIoBudget, RaiderIoBudgetStore],
  exports: [SweepEvents, IngestionCoordinator, QuotaBudget, RaiderIoBudget],
})
export class CommonModule {}
