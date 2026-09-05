import type { Bracket, Region } from '../../blizzard/blizzard.constants.js';

/**
 * One character's final standing in one bracket of a finished season.
 *
 * Self-contained by design: an archive row carries the name, realm and faction
 * from the leaderboard itself rather than pointing at `characters`. Historical
 * rows must keep reading correctly forever, and a character document can be
 * renamed, transferred or deleted long after the season it belonged to.
 */
export interface ArchiveEntryDocument {
  seasonId: number;
  region: Region;
  bracket: Bracket;
  characterId: number;
  characterName: string;
  realmId: number;
  realmSlug: string;
  faction: string | null;
  rank: number;
  rating: number;
  played: number;
  won: number;
  lost: number;
}

/**
 * Progress marker per season and region. Its presence is what makes the
 * backfill run once: a season already recorded here is never re-fetched.
 */
export interface ArchiveSeasonDocument {
  seasonId: number;
  region: Region;
  name?: string;
  startsAt: Date | null;
  endsAt: Date | null;
  brackets: number;
  entries: number;
  /** Brackets the API refused; the season is retried while any remain. */
  failedBrackets: Bracket[];
  archivedAt: Date;
}

export const ARCHIVE_ENTRIES_COLLECTION = 'archive_entries';
export const ARCHIVE_SEASONS_COLLECTION = 'archive_seasons';
