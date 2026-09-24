import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { MongoService } from '../database/mongo.service.js';
import {
  MPLUS_SEASON_STATE_COLLECTION,
  MPLUS_SEASON_TRANSITIONS_COLLECTION,
  type MplusSeasonStateDocument,
  type MplusSeasonTransitionDocument,
} from './entities/mplus-season.entity.js';

/**
 * Owns the two small collections that make Mythic+ season transitions durable.
 * The counterpart of `SeasonStateRepository`.
 */
@Injectable()
export class MplusSeasonStateRepository implements OnModuleInit {
  private readonly logger = new Logger(MplusSeasonStateRepository.name);

  constructor(private readonly mongo: MongoService) {}

  private get state() {
    return this.mongo.collection<MplusSeasonStateDocument>(MPLUS_SEASON_STATE_COLLECTION);
  }

  private get transitions() {
    return this.mongo.collection<MplusSeasonTransitionDocument>(
      MPLUS_SEASON_TRANSITIONS_COLLECTION,
    );
  }

  async onModuleInit(): Promise<void> {
    await this.state.createIndexes([
      { key: { region: 1 }, name: 'mplus_state_region', unique: true },
    ]);
    await this.transitions.createIndexes([
      { key: { season: 1, region: 1 }, name: 'mplus_transition_identity', unique: true },
      { key: { purgedAt: -1 }, name: 'mplus_transition_recent' },
    ]);

    this.logger.log(
      `Indexes ensured on "${MPLUS_SEASON_STATE_COLLECTION}" and ` +
        `"${MPLUS_SEASON_TRANSITIONS_COLLECTION}"`,
    );
  }

  loadAll(): Promise<MplusSeasonStateDocument[]> {
    return this.state.find({}).toArray();
  }

  async save(state: MplusSeasonStateDocument): Promise<void> {
    const { region, ...rest } = state;

    await this.state.updateOne(
      { region },
      { $set: rest, $setOnInsert: { region } },
      { upsert: true },
    );
  }

  /**
   * Records one retirement. An upsert rather than an insert: a season whose
   * rows came back after a purge — a pass that was already running when the
   * season rolled — is retired again, and the record should say when it last was.
   */
  async recordPurge(transition: MplusSeasonTransitionDocument): Promise<void> {
    const { season, region, ...rest } = transition;

    await this.transitions.updateOne(
      { season, region },
      { $set: rest, $setOnInsert: { season, region } },
      { upsert: true },
    );
  }

  /** Most recent purges first, for the health endpoint. */
  recentPurges(limit = 20): Promise<MplusSeasonTransitionDocument[]> {
    return this.transitions.find({}).sort({ purgedAt: -1 }).limit(limit).toArray();
  }
}
