import type { RaiderIoRegion } from '../../raiderio/raiderio.constants.js';

/** A dungeon, flattened to the fields a board actually reads. */
export interface MplusDungeonRef {
  id: number;
  name: string;
  slug: string;
  shortName: string | null;
}

/**
 * One member of a run's party.
 *
 * Self-contained, like `archive_entries`: no reference into `mplus_characters`.
 * A run is a historical fact and must keep reading correctly after the
 * character is renamed, transferred, deleted, or drops off the leaderboard and
 * is pruned. It also keeps anonymised players in the roster — a five-person run
 * with four members listed would be wrong — where `mplus_characters` cannot
 * hold them at all.
 */
export interface MplusRosterMember {
  /**
   * Raider.io's character id. **Not Blizzard's** — see
   * `rosterCharacterSchema`. `0` for anonymised characters, so it is stored for
   * reference and never used as a key.
   */
  rioCharacterId: number;
  characterName: string;
  realmSlug: string;
  /** Blizzard's realm id (`wowRealmId`); null for an anonymised realm. */
  realmId: number | null;
  region: string;
  classId: number;
  className: string;
  /** Null on the rare entry Raider.io reports without one. */
  specId: number | null;
  specName: string | null;
  role: string;
  faction: string | null;
  /** True when the player has opted out of public profiles. */
  anonymized: boolean;
}

/**
 * One completed Mythic+ run from the Raider.io leaderboard.
 *
 * The identity is `season + region + keystoneRunId`. The run id alone would
 * very likely do, but the season and region prefix is what lets a board read a
 * region's runs from the index rather than filtering a global scan, and it
 * keeps the collection partitionable by season the way every other collection
 * here is.
 */
export interface MplusRunDocument {
  /** Raider.io's season slug, e.g. `season-mn-2`. */
  season: string;
  region: RaiderIoRegion;
  keystoneRunId: number;
  /** Rank within the leaderboard this run was read from, and its score. */
  rank: number;
  score: number;
  dungeon: MplusDungeonRef;
  mythicLevel: number;
  clearTimeMs: number;
  /** The dungeon's par time for this run, as the API reported it. */
  keystoneTimeMs: number | null;
  /**
   * Milliseconds under par. Negative would mean a depleted key, but the
   * leaderboard only publishes timed runs — every run in a 2,000-run sample was
   * `status: "finished"` with `num_chests >= 1` and time to spare — so in
   * practice this says *by how much* a run was timed, not *whether* it was.
   */
  timeRemainingMs: number | null;
  /** Keystone upgrades: 1, 2 or 3. */
  numChests: number | null;
  completedAt: Date;
  /**
   * Affix ids only. The names and descriptions live once in `mplus_affixes`,
   * rather than being repeated across every run document — three affixes with a
   * ~120-character description each, across ~100,000 runs a sweep, is about
   * 36MB of duplicated prose.
   */
  affixIds: number[];
  faction: string | null;
  roster: MplusRosterMember[];
  /**
   * Identity keys of the roster, mirrored flat so one index can answer "every
   * run this character appears in". Anonymised members are left out — they have
   * no identity to look up by.
   */
  rosterKeys: string[];
  fetchedAt: Date;
}

export const MPLUS_RUNS_COLLECTION = 'mplus_runs';
