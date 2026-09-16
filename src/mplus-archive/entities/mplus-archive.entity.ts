import type { MplusCharacterDocument } from '../../mplus/entities/mplus-character.entity.js';
import type { MplusRunDocument } from '../../mplus/entities/mplus-run.entity.js';

/**
 * Where a season's archive stands. Its presence and status are what make the
 * archive run once: a `complete` season is never fetched again.
 *
 * A durable record rather than an inference from stored rows, for the reason
 * `archive_brackets` exists on the PvP side (SKILLS §5.4): rows cannot tell a
 * fetch that finished from one that died halfway, and a board shallower than
 * the page limit stores fewer rows without anything having gone wrong.
 */
export interface MplusSeasonArchiveMarker {
  /**
   * `complete` — every page planned was read, or the board ended first. Never
   * fetched again.
   * `incomplete` — at least one page failed. Retried on a later tick, in full,
   * because the character fold needs every page at once.
   * `unarchivable` — Raider.io answered 404 for the season. Recorded so one
   * dead season cannot block the backlog behind it, and never retried.
   */
  status: 'complete' | 'incomplete' | 'unarchivable';
  pagesPlanned: number;
  pagesFetched: number;
  failedPages: number[];
  runs: number;
  characters: number;
  /** Runs skipped because their roster named a region this service does not know. */
  skippedRuns: number;
  archivedAt: Date;
  /** How the marker was written: by fetching, or recovered from stored rows. */
  source: 'fetched' | 'adopted';
  lastError?: string;
}

/**
 * One main Mythic+ season, as Raider.io's static data describes it.
 *
 * Main seasons only. Side events — break-the-meta weeks, "post" tails, Legion
 * Timewalking and Remix, 35 of the 56 seasons Raider.io lists — are never
 * archived, so a catalogue entry for one would describe a season nothing in the
 * database has data for. Filtering them out loses no dungeon: the 21 main
 * seasons between them list all 74.
 *
 * The catalogue is the list the archive works from, and the only place the
 * archive learns that a season has ended.
 */
export interface MplusSeasonDocument {
  slug: string;
  name: string;
  shortName: string | null;
  expansionId: number;
  /** Blizzard's M+ season id: 0 for all of Legion, reference only. */
  blizzardSeasonId: number | null;
  /** Per-region start and end, keyed by region slug. */
  starts: Record<string, Date>;
  ends: Record<string, Date>;
  /** Dungeons the season ran, by id; details live in `mplus_dungeons`. */
  dungeonIds: number[];
  catalogueUpdatedAt: Date;
  /**
   * Absent until the archive has tried the season. Written only by the
   * archive, and deliberately never by a catalogue refresh, so re-reading
   * Raider.io's season list can never erase the record of what was archived.
   */
  archive?: MplusSeasonArchiveMarker;
}

/**
 * One dungeon, once, however many seasons and expansions ran it.
 *
 * Dungeon ids are stable across expansions — 31 of 74 recur — so a season
 * references ids and this holds the details, the same split the affixes follow.
 */
export interface MplusDungeonDocument {
  id: number;
  slug: string;
  name: string;
  shortName: string | null;
  challengeModeId: number | null;
  keystoneTimerSeconds: number | null;
  iconUrl: string | null;
  backgroundImageUrl: string | null;
  /** Every expansion whose seasons ran it. Grows; never shrinks. */
  expansionIds: number[];
  updatedAt: Date;
}

/**
 * An archived run: the same shape as a live one, kept in its own collection.
 *
 * Separate collections rather than a flag on the live ones, as the PvP archive
 * is. The live collections are rewritten, pruned and merged every pass; the
 * archive is written once and never touched again. Sharing documents would put
 * history within reach of every cleanup written for the live board.
 *
 * `region` is the run's own, read from its roster (`runRegionOf`), because the
 * archive reads the `world` board and the query names no region.
 */
export type MplusArchiveRunDocument = MplusRunDocument;

/**
 * An archived character: the same shape as a live one, in its own collection.
 *
 * `mythicScore` here is summed over this season's top world runs only — at the
 * default 100 pages, the top 2,000 runs across every region. It is a narrower
 * window than the live board's 20,020 per region, so it is comparable only
 * between characters with the same `dungeonsCovered`, and not with live scores.
 * It never needs the live pass's monotonic merge: the season is over, and the
 * document is written once from one complete read.
 */
export type MplusArchiveCharacterDocument = MplusCharacterDocument;

export const MPLUS_SEASONS_COLLECTION = 'mplus_seasons';
export const MPLUS_DUNGEONS_COLLECTION = 'mplus_dungeons';
export const MPLUS_ARCHIVE_RUNS_COLLECTION = 'mplus_archive_runs';
export const MPLUS_ARCHIVE_CHARACTERS_COLLECTION = 'mplus_archive_characters';
