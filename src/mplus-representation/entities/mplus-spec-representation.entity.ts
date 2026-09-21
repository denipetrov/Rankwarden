import type { RaiderIoRegion } from '../../raiderio/raiderio.constants.js';

/** The region a representation document covers: one region, or all of them together. */
export type MplusRepresentationRegion = RaiderIoRegion | 'all';

/** One specialisation's share of a season's runs. */
export interface MplusSpecShare {
  classId: number;
  className: string;
  specId: number;
  specName: string;
  /** `tank`, `healer` or `dps`, as the roster reports it. */
  role: string;
  /** Roster slots this spec filled across the runs counted. */
  count: number;
  /** Share of every classified slot, as a percentage, 0–100. */
  percent: number;
  /**
   * Share of the slots of its own role, as a percentage, 0–100.
   *
   * The figure to compare specs by. A run always brings one tank, one healer and
   * three damage dealers, so the most-played tank has a smaller `percent` than a
   * mid-table damage spec while being the tank almost every group brings.
   */
  rolePercent: number;
}

/**
 * Which specialisations a Mythic+ season's top runs were played with, per region.
 *
 * Counted by **roster slot**: every member of every stored run counts once for
 * their spec, so a player in forty runs counts forty times. That is how often a
 * spec is brought to the top of the board, which is what Raider.io's own
 * spec-usage figures measure — not how many distinct players play it.
 *
 * One document per season and region, plus one with `region: 'all'` combining
 * every region. Its inputs are the runs stored for the season — the live board
 * (`source: 'live'`) or the archive (`source: 'archive'`) — so it describes the
 * top of each region's board to the depth that was read, not every run played.
 */
export interface MplusSpecRepresentationDocument {
  season: string;
  /** Blizzard's M+ season id, for reference. */
  seasonId: number | null;
  region: MplusRepresentationRegion;
  /**
   * `live` — recomputed after every live pass while the season is current.
   * `archive` — written once, when the archive holds the season in every
   * region, and never recomputed: a finished season's runs cannot change.
   */
  source: 'live' | 'archive';
  /** Runs counted. */
  runs: number;
  /** Roster slots counted, anonymised players included: their spec is still reported. */
  slots: number;
  /** Slots whose spec was known. `percent` is a share of these. */
  classified: number;
  /** Classified slots per role; `rolePercent` is a share of these. */
  roles: Record<string, number>;
  /** Highest count first. */
  specs: MplusSpecShare[];
  computedAt: Date;
}

export const MPLUS_SPEC_REPRESENTATION_COLLECTION = 'mplus_spec_representation';
