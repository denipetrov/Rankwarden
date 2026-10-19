import { Injectable } from '@nestjs/common';

import type { Bracket, Region } from '../blizzard/blizzard.constants.js';
import { BlizzardApiError } from '../blizzard/http/blizzard-api.error.js';
import { PvpApi } from '../blizzard/pvp.api.js';
import { describeError } from '../common/utils/errors.js';
import type { SeasonReward } from './season-reward.entity.js';
import { mapSeasonRewards, specIdsIn, specLadderSuffix } from './season-rewards.js';

/**
 * A spec's class could not be looked up for a reason other than Blizzard not
 * knowing the spec. Thrown instead of the underlying `BlizzardApiError` so a
 * caller deciding whether the *rewards* were refused cannot mistake a failed
 * spec lookup for that.
 */
export class SpecLookupError extends Error {
  constructor(cause: unknown) {
    super(`could not resolve the specs in the rewards: ${describeError(cause)}`);
    this.name = 'SpecLookupError';
  }
}

/** A season's rewards, attached to its ladders, and what could not be placed. */
export interface FetchedSeasonRewards {
  rewards: SeasonReward[];
  unmatched: string[];
}

/**
 * Reads a season's titles and their rating cutoffs from Blizzard and attaches
 * each to the ladder it is earned on.
 *
 * Shared by the archive, which records a finished season's final cutoffs once,
 * and the live season, whose cutoffs are re-read as the ladder moves. One
 * request per season, plus one `playable-specialization` lookup the first time
 * a spec is seen: a reward names its spec only by id and bare name, and four
 * names exist on two classes, so the class is what places it on its ladder. A
 * spec never changes class, so the lookup is kept for the life of the process.
 */
@Injectable()
export class SeasonRewardsService {
  /** Blizzard spec id to the `class-spec` tail of its ladders. */
  private readonly specLadders = new Map<number, string>();

  constructor(private readonly pvpApi: PvpApi) {}

  /**
   * The rewards of one season in one region, placed on `ladders` — the
   * season's own bracket list, so a reward for a ladder it does not publish is
   * reported as unmatched rather than stored.
   *
   * `beforeRequest` runs before each request, for a caller pacing its requests
   * with a rate limiter. The rewards request's own failure propagates as the
   * `BlizzardApiError` it is (a 403 or 404 means Blizzard will not serve them);
   * a failed spec lookup propagates as `SpecLookupError`. A spec Blizzard does
   * not recognise is skipped, and its reward reported as unmatched.
   */
  async fetch(
    region: Region,
    seasonId: number,
    ladders: Iterable<Bracket>,
    beforeRequest: () => Promise<void> = async () => {},
  ): Promise<FetchedSeasonRewards> {
    await beforeRequest();
    const served = await this.pvpApi.getSeasonRewards(region, seasonId);

    try {
      await this.resolveSpecs(region, specIdsIn(served), beforeRequest);
    } catch (error) {
      throw new SpecLookupError(error);
    }

    return mapSeasonRewards(served, this.specLadders, new Set(ladders));
  }

  private async resolveSpecs(
    region: Region,
    specIds: readonly number[],
    beforeRequest: () => Promise<void>,
  ): Promise<void> {
    for (const specId of specIds) {
      if (this.specLadders.has(specId)) continue;

      try {
        await beforeRequest();
        const spec = await this.pvpApi.getSpecialization(region, specId);
        this.specLadders.set(specId, specLadderSuffix(spec.className, spec.name));
      } catch (error) {
        if (!(error instanceof BlizzardApiError && error.isNotFound)) throw error;
      }
    }
  }
}
