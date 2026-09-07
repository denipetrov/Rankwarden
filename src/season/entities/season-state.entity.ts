import type { Region } from '../../blizzard/blizzard.constants.js';

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

export const SEASON_STATE_COLLECTION = 'season_state';
export const SEASON_TRANSITIONS_COLLECTION = 'season_transitions';
