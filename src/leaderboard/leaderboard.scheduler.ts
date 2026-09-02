import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';

import type { Env } from '../config/env.schema.js';
import { LeaderboardService } from './leaderboard.service.js';

const INTERVAL_NAME = 'leaderboard-sweep';

/** Kicks off the first sweep at boot and re-runs it on a configurable interval. */
@Injectable()
export class LeaderboardScheduler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(LeaderboardScheduler.name);
  private readonly intervalMs: number;
  private readonly runOnStartup: boolean;

  constructor(
    config: ConfigService<Env, true>,
    private readonly leaderboards: LeaderboardService,
    private readonly scheduler: SchedulerRegistry,
  ) {
    this.intervalMs = config.get('INGEST_INTERVAL_MS', { infer: true });
    this.runOnStartup = config.get('INGEST_RUN_ON_STARTUP', { infer: true });
  }

  onApplicationBootstrap(): void {
    const interval = setInterval(() => void this.run('interval'), this.intervalMs);
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.logger.log(`Sweep scheduled every ${this.intervalMs}ms`);

    if (this.runOnStartup) {
      void this.run('startup');
    }
  }

  onModuleDestroy(): void {
    if (this.scheduler.doesExist('interval', INTERVAL_NAME)) {
      this.scheduler.deleteInterval(INTERVAL_NAME);
    }
  }

  private async run(trigger: 'startup' | 'interval'): Promise<void> {
    this.logger.log(`Starting ${trigger} sweep`);

    try {
      await this.leaderboards.sweep();
    } catch (error) {
      this.logger.error(`Unhandled error during ${trigger} sweep`, error as Error);
    }
  }
}
