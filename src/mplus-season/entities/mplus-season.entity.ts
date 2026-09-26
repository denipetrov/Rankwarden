import type { RaiderIoRegion } from '../../raiderio/raiderio.constants.js';
import type { MplusSeasonCutoffs } from './mplus-cutoffs.entity.js';

/**
 * One region's share of a season's archive.
 *
 * The archive reads each region's own board, as the live pass does, so each
 * region is settled on its own: a retry re-reads only the regions that are not
 * `complete`, and the season transition can retire a region's live board as
 * soon as that region is archived.
 */
export interface MplusRegionArchive {
  /**
   * `complete` — every page planned was read, or the board ended first. A
   * region with no board at all for the season (Legion and BfA in `cn`) ends on
   * page 0 and is complete with no runs.
   * `incomplete` — at least one page failed; the region is read again, in full,
   * on a later tick, because the character fold needs every page at once.
   */
  status: 'complete' | 'incomplete';
  pagesFetched: number;
  failedPages: number[];
  runs: number;
  characters: number;
  archivedAt: Date;
  /** How it was written: by fetching, or recovered from stored rows. */
  source: 'fetched' | 'adopted';
}

/**
 * Where a season's archive stands. Its presence and status are what make the
 * archive run once: a season whose every configured region is `complete` is
 * never fetched again.
 *
 * A durable record rather than an inference from stored rows, for the reason
 * `archive_brackets` exists on the PvP side (SKILLS §5.4): rows cannot tell a
 * fetch that finished from one that died halfway, and a board shallower than
 * the page limit stores fewer rows without anything having gone wrong.
 *
 * The top-level counts are totals over `regions`. A marker with no `regions`
 * was written by the earlier archive, which read the `world` board; it is
 * treated as owed, so such a season is read again region by region.
 */
export interface MplusSeasonArchiveMarker {
  /**
   * `complete` — every configured region is complete.
   * `incomplete` — a region has a failed page. Retried on a later tick.
   * `partial` — a higher-priority job interrupted the season after some
   * regions were read; the rest are read on a later tick. Nothing failed.
   * `unarchivable` — Raider.io answered 404 for the season. Recorded so one
   * dead season cannot block the backlog behind it, and never retried.
   */
  status: 'complete' | 'incomplete' | 'partial' | 'unarchivable';
  /** Pages planned per region. */
  pagesPlanned: number;
  pagesFetched: number;
  /** Failed pages as `region:page`, e.g. `eu:7`. */
  failedPages: string[];
  runs: number;
  characters: number;
  regions: Partial<Record<RaiderIoRegion, MplusRegionArchive>>;
  archivedAt: Date;
  /** `adopted` only when every region was recovered from stored rows. */
  source: 'fetched' | 'adopted';
  lastError?: string;
}

/**
 * One main Mythic+ season, as Raider.io's static data describes it.
 *
 * Main seasons only. Side events — break-the-meta weeks, "post" tails, Legion
 * Timewalking and Remix, 35 of the 56 seasons Raider.io lists — are never
 * ingested or archived, so a catalogue entry for one would describe a season
 * nothing in the database has data for. Filtering them out loses no dungeon:
 * the 21 main seasons between them list all 74.
 *
 * The catalogue is the one source of truth for which season is current in each
 * region (`currentSeasonIn`), and the only place the archive learns that a
 * season has ended.
 */
export interface MplusSeasonDocument {
  /**
   * Set when a complete catalogue walk no longer lists the season — renamed or
   * dropped upstream, or below a raised `MPLUS_CATALOGUE_FIRST_EXPANSION` — and
   * cleared if a later walk lists it again. Such a season is never re-stamped,
   * so it is left out of the catalogue's freshness; everything else about it is
   * kept, archive included.
   */
  unlistedAt?: Date;
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
  /**
   * Title and percentile cutoffs per region (`MplusSeasonCutoffs`), read from
   * `mythic-plus/season-cutoffs`. Absent for a region never asked; a region
   * Raider.io has no cutoffs for is recorded as such rather than left absent,
   * so it is asked once and not again.
   */
  cutoffs?: Partial<Record<RaiderIoRegion, MplusSeasonCutoffs>>;
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
 * The Mythic+ season last observed as current in a region, persisted so a
 * rollover that happens while the process is down is still recognised as one.
 *
 * The counterpart of `SeasonStateDocument`, and there for the same reason: a
 * fresh process has nothing in memory to compare against, and without this a
 * rollover across a restart would read as a first observation.
 */
export interface MplusSeasonStateDocument {
  region: RaiderIoRegion;
  season: string;
  name: string;
  startsAt: Date;
  /**
   * The season's end in this region, as the catalogue lists it. A running
   * season carries Raider.io's `2030-01-01` placeholder, so "ended" is always
   * `endsAt <= now`, never "has an end date".
   */
  endsAt: Date | null;
  /** Whether the end had passed when this was observed. */
  ended: boolean;
  observedAt: Date;
}

/** Audit record of one Mythic+ season retired from the live collections in one region. */
export interface MplusSeasonTransitionDocument {
  season: string;
  region: RaiderIoRegion;
  purgedAt: Date;
  /** Documents removed per collection, for the post-mortem after a bad purge. */
  removed: Record<string, number>;
  /** The season whose start in the region made the old one superseded. */
  triggeredBy: string;
  dryRun: boolean;
}

export const MPLUS_SEASONS_COLLECTION = 'mplus_seasons';
export const MPLUS_DUNGEONS_COLLECTION = 'mplus_dungeons';
export const MPLUS_SEASON_STATE_COLLECTION = 'mplus_season_state';
export const MPLUS_SEASON_TRANSITIONS_COLLECTION = 'mplus_season_transitions';
