import { Injectable } from '@nestjs/common';

import type { Region } from '../blizzard/blizzard.constants.js';
import { MongoService } from '../database/mongo.service.js';
import type { SeasonReward } from '../rewards/season-reward.entity.js';
import {
  type SeasonStateDocument,
  type SeasonTransitionDocument,
} from './entities/season-state.entity.js';
import { SEASON_STATE_COLLECTION, SEASON_TRANSITIONS_COLLECTION } from '../database/collections.js';

/** Owns the two small collections that make season transitions durable. */
@Injectable()
export class SeasonStateRepository {
  constructor(private readonly mongo: MongoService) {}

  private get state() {
    return this.mongo.collection<SeasonStateDocument>(SEASON_STATE_COLLECTION);
  }

  private get transitions() {
    return this.mongo.collection<SeasonTransitionDocument>(SEASON_TRANSITIONS_COLLECTION);
  }

  async loadAll(): Promise<SeasonStateDocument[]> {
    return this.state.find({}).toArray();
  }

  /**
   * Records what was observed of a region's season. The rewards are not part of
   * it and are left as they are — unless the season itself changed, when the
   * old season's rewards are removed first: they describe a ladder that no
   * longer exists, and showing them under the new season would be wrong.
   */
  async save(state: Omit<SeasonStateDocument, 'rewards' | 'rewardsFetchedAt'>): Promise<void> {
    const { region, ...rest } = state;

    await this.state.updateOne(
      { region, seasonId: { $ne: rest.seasonId } },
      { $unset: { rewards: '', rewardsFetchedAt: '' } },
    );
    await this.state.updateOne(
      { region },
      { $set: rest, $setOnInsert: { region } },
      { upsert: true },
    );
  }

  /**
   * Stores the current season's rewards. Only onto the season they were read
   * for: if the region has rolled over since, nothing is written and false is
   * returned.
   */
  async recordRewards(
    region: Region,
    seasonId: number,
    rewards: readonly SeasonReward[],
    fetchedAt: Date,
  ): Promise<boolean> {
    const result = await this.state.updateOne(
      { region, seasonId },
      { $set: { rewards: [...rewards], rewardsFetchedAt: fetchedAt } },
    );

    return result.matchedCount > 0;
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
