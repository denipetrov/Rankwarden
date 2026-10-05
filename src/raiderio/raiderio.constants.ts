/**
 * Regions Raider.io serves M+ leaderboards for.
 *
 * Deliberately its own list rather than Blizzard's `REGIONS`. Raider.io serves
 * China, which the Blizzard Game Data API does not (it sits behind a separate
 * host with separate credentials), so the two lists genuinely differ and
 * folding them together would either drop `cn` from M+ or imply the PvP sweep
 * could cover it.
 */
export const RAIDERIO_REGIONS = ['us', 'eu', 'kr', 'tw', 'cn'] as const;
export type RaiderIoRegion = (typeof RAIDERIO_REGIONS)[number];

/**
 * The aggregate pseudo-region. It is the union of the real ones, so ingesting
 * it alongside them would fetch every run twice and leave the runs with no
 * region of their own to be filtered by. Nothing reads it — the live pass and
 * the archive both read each region's own board — and it is named only so the
 * configuration can refuse it.
 */
export const AGGREGATE_REGION = 'world';

/**
 * Regions `/raiding/raid-rankings` serves a board for. Unlike the Mythic+ runs,
 * the aggregate is worth reading here: the world ranking is a race of its own,
 * not a second copy of the regional ones, and it is a hundred guilds rather
 * than twenty thousand runs.
 */
export const RAID_RANKING_REGIONS = [AGGREGATE_REGION, ...RAIDERIO_REGIONS] as const;
export type RaidRankingRegion = (typeof RAID_RANKING_REGIONS)[number];

/**
 * The difficulties `/raiding/raid-rankings` ranks, hardest first: each is a
 * board of its own, with its own top hundred. `difficulty` is required by the
 * endpoint: without it, or with one it does not know (`lfr`), it answers 400
 * "Invalid request query input".
 */
export const RAID_DIFFICULTIES = ['mythic', 'heroic', 'normal'] as const;
export type RaidDifficulty = (typeof RAID_DIFFICULTIES)[number];

/** Guilds kept per board: the top hundred. */
export const RAID_RANKING_TOP = 100;

/**
 * Guilds asked for per request, so a board is five pages.
 *
 * The endpoint would serve the hundred in one — `limit` goes to 200 — but its
 * cost is per guild and far from flat: checked live (2026-10-02), one request
 * for a hundred guilds of an older raid took 40-60s and Amirdrassil's world
 * board answered 504 from the gateway at 60s every time, while the same board
 * twenty at a time took 1-2s a page. Nothing upstream stays cached between
 * reads either, so the slow request is slow again an hour later.
 */
export const RAID_RANKING_PAGE_SIZE = 20;

/** Runs per page, fixed by the API — the endpoint takes no page-size parameter. */
export const RUNS_PER_PAGE = 20;

/**
 * Highest `page` the runs endpoint accepts. Asking for 1001 answers
 * `400 {"message":"\"page\" must be less than or equal to 1000"}`, so a pass is
 * pages 0-1000 inclusive: 1001 requests and up to 20,020 runs per region.
 */
export const MAX_RUNS_PAGE = 1000;

/**
 * The first expansion with Mythic+ seasons. Legion introduced Mythic+, and
 * `static-data?expansion_id=5` answers with dungeons but no seasons at all.
 */
export const FIRST_MPLUS_EXPANSION_ID = 6;
