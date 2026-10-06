import { RATING_FAMILIES, type RatingFamily } from '../blizzard/blizzard.constants.js';

/**
 * Every MongoDB collection this service creates, named in one place.
 *
 * These used to sit next to the document interface each one stores, which read
 * naturally per module and badly as a whole: nothing answered "what does this
 * service own in the database?" without a repository-wide search, and two
 * modules could have reached for the same name without anything noticing. The
 * document shapes stay with their modules — only the names moved.
 *
 * A name is a wire contract. Collections already hold data under these names,
 * so renaming one is a migration, not an edit.
 *
 * Adding a collection means adding it here and to `ALL_COLLECTIONS`.
 */

// ------------------------------------------------------------------ PvP, live

/** One document per character per season+region, brackets nested inside. */
export const CHARACTERS_COLLECTION = 'characters';

/**
 * One collection per rating family, so each board is its own sorted range.
 * Derived from `RATING_FAMILIES`, which is what drives the sweep's fan-out: a
 * new family appears here, and its collection is created, without an edit.
 */
export const RATING_COLLECTIONS = Object.fromEntries(
  RATING_FAMILIES.map((family) => [family, `${family}_ratings`]),
) as Record<RatingFamily, string>;

/** Daily specialisation representation snapshots. */
export const SPEC_REPRESENTATION_COLLECTION = 'spec_representation';

/** The active season per region, so a rollover survives a restart. */
export const SEASON_STATE_COLLECTION = 'season_state';

/** An audit row per observed season transition. */
export const SEASON_TRANSITIONS_COLLECTION = 'season_transitions';

// --------------------------------------------------------------- PvP, archive

/** Final standings of finished seasons, self-contained. */
export const ARCHIVE_ENTRIES_COLLECTION = 'archive_entries';

/** The run-once marker per archived season, with its reward cutoffs. */
export const ARCHIVE_SEASONS_COLLECTION = 'archive_seasons';

/** Which brackets were fetched, whatever they turned out to contain. */
export const ARCHIVE_BRACKETS_COLLECTION = 'archive_brackets';

// ------------------------------------------------------------- Mythic+, live

/** Top Mythic+ runs. */
export const MPLUS_RUNS_COLLECTION = 'mplus_runs';

/** Characters named by those runs; never profile-enriched. */
export const MPLUS_CHARACTERS_COLLECTION = 'mplus_characters';

/** The affix rotation per week and region. */
export const MPLUS_AFFIXES_COLLECTION = 'mplus_affixes';

/** Daily Mythic+ specialisation representation snapshots. */
export const MPLUS_SPEC_REPRESENTATION_COLLECTION = 'mplus_spec_representation';

/** The Mythic+ season catalogue. */
export const MPLUS_SEASONS_COLLECTION = 'mplus_seasons';

/** The dungeons each Mythic+ season runs. */
export const MPLUS_DUNGEONS_COLLECTION = 'mplus_dungeons';

/** The active Mythic+ season per region. */
export const MPLUS_SEASON_STATE_COLLECTION = 'mplus_season_state';

/** An audit row per observed Mythic+ season transition. */
export const MPLUS_SEASON_TRANSITIONS_COLLECTION = 'mplus_season_transitions';

// ----------------------------------------------------------- Mythic+, archive

/** Runs kept from finished Mythic+ seasons. */
export const MPLUS_ARCHIVE_RUNS_COLLECTION = 'mplus_archive_runs';

/** Characters kept from finished Mythic+ seasons. */
export const MPLUS_ARCHIVE_CHARACTERS_COLLECTION = 'mplus_archive_characters';

// -------------------------------------------------------------------- Raiding

/** The raid catalogue, boards included. */
export const RAIDS_COLLECTION = 'raids';

/** Guild progression rows behind those boards. */
export const GUILDS_COLLECTION = 'guilds';

// ------------------------------------------------------------- Infrastructure

/**
 * Rolling request windows, so a restart does not forget what an upstream quota
 * has already been charged this hour.
 */
export const QUOTA_WINDOWS_COLLECTION = 'quota_windows';

/**
 * Every collection above, for anything that has to work over all of them —
 * diagnostics, a document census, a test that holds every collection to the
 * same rule. Not a schema and not an ordering: the season purges name their own
 * collections explicitly, because for them the order is load-bearing.
 */
export const ALL_COLLECTIONS: readonly string[] = [
  CHARACTERS_COLLECTION,
  ...RATING_FAMILIES.map((family) => RATING_COLLECTIONS[family]),
  SPEC_REPRESENTATION_COLLECTION,
  SEASON_STATE_COLLECTION,
  SEASON_TRANSITIONS_COLLECTION,
  ARCHIVE_ENTRIES_COLLECTION,
  ARCHIVE_SEASONS_COLLECTION,
  ARCHIVE_BRACKETS_COLLECTION,
  MPLUS_RUNS_COLLECTION,
  MPLUS_CHARACTERS_COLLECTION,
  MPLUS_AFFIXES_COLLECTION,
  MPLUS_SPEC_REPRESENTATION_COLLECTION,
  MPLUS_SEASONS_COLLECTION,
  MPLUS_DUNGEONS_COLLECTION,
  MPLUS_SEASON_STATE_COLLECTION,
  MPLUS_SEASON_TRANSITIONS_COLLECTION,
  MPLUS_ARCHIVE_RUNS_COLLECTION,
  MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
  RAIDS_COLLECTION,
  GUILDS_COLLECTION,
  QUOTA_WINDOWS_COLLECTION,
];
