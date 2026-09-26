import {
  BeforeApplicationShutdown,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';

import { MongoService } from '../../database/mongo.service.js';
import { describeError } from '../utils/errors.js';
import { RaiderIoBudget, type RaiderIoConsumer } from './raiderio-budget.service.js';

export const QUOTA_WINDOWS_COLLECTION = 'quota_windows';
const DOCUMENT_ID = 'raiderio';
/** How often a changed minute is written. Well inside the minute it describes. */
const FLUSH_MS = 5_000;

interface QuotaWindowDocument {
  _id: string;
  buckets: { index: number; counts: Partial<Record<RaiderIoConsumer, number>> }[];
  savedAt: Date;
}

/**
 * Carries the Raider.io minute across a restart.
 *
 * The window is only a minute, but that is the point: a process that restarts
 * mid-pass would otherwise come back with a whole fresh minute on top of the
 * one it had just spent, and the first pass after boot would spend both. The
 * Blizzard budget is an hour and is not persisted; this one is cheap to — one
 * small document, written every few seconds while requests are being made, and
 * once more on shutdown.
 *
 * Best effort by design: a failed read or write is logged and ignored, because
 * a budget that could stop the service booting would be worse than one that
 * occasionally forgets a minute.
 */
@Injectable()
export class RaiderIoBudgetStore
  implements OnApplicationBootstrap, OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly logger = new Logger(RaiderIoBudgetStore.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly mongo: MongoService,
    private readonly budget: RaiderIoBudget,
  ) {}

  private get collection() {
    return this.mongo.collection<QuotaWindowDocument>(QUOTA_WINDOWS_COLLECTION);
  }

  async onApplicationBootstrap(): Promise<void> {
    try {
      const saved = await this.collection.findOne({ _id: DOCUMENT_ID });
      if (saved) this.budget.restoreSnapshot(saved.buckets);
    } catch (error) {
      this.logger.warn(`Could not restore the Raider.io budget window: ${describeError(error)}`);
    }

    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Before Mongo closes, which it does in `onApplicationShutdown`. */
  async beforeApplicationShutdown(): Promise<void> {
    await this.flush();
  }

  /** Writes the minute if anything was charged since the last write. */
  async flush(): Promise<void> {
    const buckets = this.budget.takeSnapshot();
    if (!buckets) return;

    try {
      await this.collection.replaceOne(
        { _id: DOCUMENT_ID },
        { buckets, savedAt: new Date() },
        { upsert: true },
      );
    } catch (error) {
      this.logger.warn(`Could not save the Raider.io budget window: ${describeError(error)}`);
    }
  }
}
