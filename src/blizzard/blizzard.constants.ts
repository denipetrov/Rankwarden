/** Regions served by the global Blizzard Game Data API (CN uses a separate host). */
export const REGIONS = ['us', 'eu', 'kr', 'tw'] as const;
export type Region = (typeof REGIONS)[number];

/** PvP leaderboard brackets this service ingests. */
export const BRACKETS = ['2v2', '3v3', 'rbg', 'shuffle-overall', 'blitz-overall'] as const;
export type Bracket = (typeof BRACKETS)[number];

export function isRegion(value: string): value is Region {
  return (REGIONS as readonly string[]).includes(value);
}

/** Host for a region's Game Data API, e.g. https://us.api.blizzard.com */
export function apiHost(region: Region): string {
  return `https://${region}.api.blizzard.com`;
}

/** Dynamic namespace for a region, e.g. dynamic-us */
export function dynamicNamespace(namespace: string, region: Region): string {
  return `${namespace}-${region}`;
}
