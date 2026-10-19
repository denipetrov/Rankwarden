import type { Region } from '../../blizzard/blizzard.constants.js';
import type { SeasonReward } from '../../rewards/season-reward.entity.js';

/**
 * The last season observed for a region, persisted so a rollover that happens
 * while the process is down is still recognised as a rollover.
 *
 * Previously this lived only in a private in-memory Map, which meant a fresh
 * process had no previous value to compare against and took the plain "active
 * season" branch — harmless while nothing reacted to the transition, wrong the
 * moment a purge hangs off it.
 */
export interface SeasonStateDocument {
  region: Region;
  seasonId: number;
  name?: string;
  startsAt: Date;
  /** Null while the season is still running. */
  endsAt: Date | null;
  lastCompletedSeasonId: number | null;
  observedAt: Date;
  /**
   * The current season's titles and the rating each currently takes, one entry
   * per ladder and, where the title differs by side, per faction — the shape
   * `archive_seasons.rewards` has for a finished season. Compare a character's
   * rating on `bracket` with `ratingCutoff` to see whether they would earn
   * `title` if the season ended now.
   *
   * Re-read after every sweep, because the cutoffs move with the ladder; they
   * are final only once the season has ended. Absent until first read, and
   * cleared when the region rolls over to a new season.
   */
  rewards?: SeasonReward[];
  /** When `rewards` was last read from Blizzard. */
  rewardsFetchedAt?: Date;
}

/** Audit record of one season retired from the live collections. */
export interface SeasonTransitionDocument {
  seasonId: number;
  region: Region;
  purgedAt: Date;
  /** Documents removed per collection, for the post-mortem after a bad purge. */
  removed: Record<string, number>;
  /** Which season's start opened the gate. */
  triggeredBy: number;
  dryRun: boolean;
}
