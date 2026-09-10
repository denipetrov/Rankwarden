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
  /**
   * Set when Blizzard will never serve this season - seasons below 22 are gone
   * for good. Distinct from a complete archive: nothing was stored, but there
   * is nothing to come back for either, so the backlog moves on.
   */
  unarchivable?: boolean;
  lastError?: string;
}

/**
 * One bracket that was actually fetched, whatever it turned out to contain.
 *
 * Completeness used to be inferred from stored rows, which cannot tell a ladder
 * nobody qualified for from one that was never fetched at all: both store
 * nothing. On a small region plenty of the 80 spec ladders finish a season
 * empty, so a season with any of them could never be adopted from its rows and
 * the cheap recovery path was defeated for exactly the seasons it mattered on.
 *
 * Recording the fetch rather than its output removes the inference. Kept in its
 * own collection so `archive_entries` stays purely the standings and needs no
 * filtering, and so the record survives losing `archive_seasons`.
 */
export interface ArchiveBracketDocument {
  seasonId: number;
  region: Region;
  bracket: Bracket;
  /** How many rows this bracket contributed; zero is a real, useful answer. */
  entries: number;
  fetchedAt: Date;
}

export const ARCHIVE_ENTRIES_COLLECTION = 'archive_entries';
export const ARCHIVE_SEASONS_COLLECTION = 'archive_seasons';
export const ARCHIVE_BRACKETS_COLLECTION = 'archive_brackets';
