import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongoClient, type Collection, type Db, type Document } from 'mongodb';

import type { Env } from '../config/env.schema.js';

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  /** Raw driver message; redact before it reaches a response. */
  error: string | null;
}

/** How long one ping answers for. Long enough to absorb a probe storm. */
const PING_CACHE_MS = 3_000;

/** Owns the MongoClient lifecycle and hands out typed collections. */
@Injectable()
export class MongoService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MongoService.name);
  private readonly client: MongoClient;
  private readonly dbName: string;
  private cachedPing: { at: number; result: PingResult } | null = null;

  constructor(config: ConfigService<Env, true>) {
    this.client = new MongoClient(config.get('MONGODB_URI', { infer: true }));
    this.dbName = config.get('MONGODB_DB', { infer: true });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
    this.logger.log(`Connected to MongoDB database "${this.dbName}"`);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.client.close();
    this.logger.log('MongoDB connection closed');
  }

  get db(): Db {
    return this.client.db(this.dbName);
  }

  collection<T extends Document>(name: string): Collection<T> {
    return this.db.collection<T>(name);
  }

  /**
   * Round-trips a `ping` to the server, with the result cached briefly.
   *
   * The readiness endpoint is unauthenticated, so without the cache a burst of
   * probes turns into a burst of commands against the primary. One ping per
   * window answers every caller in it.
   */
  async ping(): Promise<PingResult> {
    const now = Date.now();

    if (this.cachedPing && now - this.cachedPing.at < PING_CACHE_MS) {
      return this.cachedPing.result;
    }

    const startedAt = Date.now();
    let result: PingResult;

    try {
      await this.client.db(this.dbName).command({ ping: 1 });
      result = { ok: true, latencyMs: Date.now() - startedAt, error: null };
    } catch (error) {
      result = {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    this.cachedPing = { at: now, result };

    return result;
  }
}
