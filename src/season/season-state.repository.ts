import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { MongoService } from '../database/mongo.service.js';
import {
  SEASON_STATE_COLLECTION,
  SEASON_TRANSITIONS_COLLECTION,
  type SeasonStateDocument,
  type SeasonTransitionDocument,
} from './entities/season-state.entity.js';

/** Owns the two small collections that make season transitions durable. */
@Injectable()
export class SeasonStateRepository implements OnModuleInit {
  private readonly logger = new Logger(SeasonStateRepository.name);

  constructor(private readonly mongo: MongoService) {}

  private get state() {
    return this.mongo.collection<SeasonStateDocument>(SEASON_STATE_COLLECTION);
  }

  private get transitions() {
    return this.mongo.collection<SeasonTransitionDocument>(SEASON_TRANSITIONS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.state.createIndexes([{ key: { region: 1 }, name: 'state_region', unique: true }]);
    await this.transitions.createIndexes([
      // The once-only guard: a season/region pair is purged at most once.
      { key: { seasonId: 1, region: 1 }, name: 'transition_identity', unique: true },
      { key: { purgedAt: -1 }, name: 'transition_recent' },
    ]);

    this.logger.log(`Indexes ensured on "${SEASON_STATE_COLLECTION}"`);
  }

  async loadAll(): Promise<SeasonStateDocument[]> {
    return this.state.find({}).toArray();
  }

  async save(state: SeasonStateDocument): Promise<void> {
    const { region, ...rest } = state;

    await this.state.updateOne(
      { region },
      { $set: rest, $setOnInsert: { region } },
      { upsert: true },
    );
  }

  /** Season/region pairs already retired, so a purge never runs twice. */
  async purgedPairs(): Promise<Set<string>> {
    const done = await this.transitions
      .find({ dryRun: false }, { projection: { seasonId: 1, region: 1 } })
      .toArray();

    return new Set(done.map((entry) => `${entry.seasonId}:${entry.region}`));
  }

  async recordPurge(transition: SeasonTransitionDocument): Promise<void> {
    const { seasonId, region, ...rest } = transition;

    await this.transitions.updateOne(
      { seasonId, region },
      { $set: rest, $setOnInsert: { seasonId, region } },
      { upsert: true },
    );
  }

  /** Most recent purges first, for the health endpoint. */
  async recentPurges(limit = 20): Promise<SeasonTransitionDocument[]> {
    return this.transitions.find({}).sort({ purgedAt: -1 }).limit(limit).toArray();
  }
}
