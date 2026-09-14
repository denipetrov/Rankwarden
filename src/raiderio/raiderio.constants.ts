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
 * region of their own to be filtered by.
 */
export const AGGREGATE_REGION = 'world';

/** Runs per page, fixed by the API — the endpoint takes no page-size parameter. */
export const RUNS_PER_PAGE = 20;

/**
 * Highest `page` the runs endpoint accepts. Asking for 1001 answers
 * `400 {"message":"\"page\" must be less than or equal to 1000"}`, so a pass is
 * pages 0-1000 inclusive: 1001 requests and up to 20,020 runs per region.
 */
export const MAX_RUNS_PAGE = 1000;

/**
 * WoW expansion the M+ seasons are read from. Raider.io keys its static data
 * by expansion, and a season that has not rolled into the next expansion is
 * always listed under the current one.
 */
export const CURRENT_EXPANSION_ID = 11;
