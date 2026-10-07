import { Injectable } from '@nestjs/common';

import { MongoService } from '../database/mongo.service.js';
import {
  type MplusSeasonStateDocument,
  type MplusSeasonTransitionDocument,
} from './entities/mplus-season.entity.js';
import {
  MPLUS_SEASON_STATE_COLLECTION,
  MPLUS_SEASON_TRANSITIONS_COLLECTION,
} from '../database/collections.js';

/**
 * Owns the two small collections that make Mythic+ season transitions durable.
 * The counterpart of `SeasonStateRepository`.
 */
@Injectable()
export class MplusSeasonStateRepository {
  constructor(private readonly mongo: MongoService) {}

  private get state() {
    return this.mongo.collection<MplusSeasonStateDocument>(MPLUS_SEASON_STATE_COLLECTION);
  }

  private get transitions() {
    return this.mongo.collection<MplusSeasonTransitionDocument>(
      MPLUS_SEASON_TRANSITIONS_COLLECTION,
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
