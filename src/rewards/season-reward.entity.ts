import type { Bracket } from '../blizzard/blizzard.constants.js';

/**
 * One title and its cutoff, attached to the ladder it was earned on.
 *
 * Stored on a finished season's `archive_seasons` marker and on the live
 * season's `season_state`, in the same shape. `bracket` uses the same keys as
 * the ladders, so a cutoff for `shuffle-warrior-fury` sits next to the
 * standings for that same ladder.
 */
export interface SeasonReward {
  bracket: Bracket;
  /**
   * `ALLIANCE` or `HORDE` where the title differs by side — Blitz's Marshal and
   * Warlord, rated battlegrounds' Hero of the Alliance and of the Horde — and
   * null where one title serves both. Cutoffs usually match across the pair,
   * but not always: Shadowlands 3v3 had a different cutoff on each side.
   */
  faction: string | null;
  ratingCutoff: number;
  /** The achievement as Blizzard names it, e.g. "Galactic Legend: Midnight Season 1". */
  title: string;
  achievementId: number;
  /** Blizzard's spec, on the per-spec ladders; the same id `profile.spec` carries. */
  specialization: { id: number; name: string } | null;
}
