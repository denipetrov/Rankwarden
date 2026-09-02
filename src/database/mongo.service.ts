import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongoClient, type Collection, type Db, type Document } from 'mongodb';

import type { Env } from '../config/env.schema.js';

/** Owns the MongoClient lifecycle and hands out typed collections. */
@Injectable()
export class MongoService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(MongoService.name);
  private readonly client: MongoClient;
  private readonly dbName: string;

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
}
