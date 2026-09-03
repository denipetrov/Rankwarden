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

/**
 * Game Data namespaces. `dynamic` covers seasons and leaderboards, `profile`
 * covers per-character data, `static` covers races, classes and talent trees.
 */
export type NamespaceKind = 'dynamic' | 'profile' | 'static';

/** Namespace for a region, e.g. dynamic-us or profile-eu */
export function namespaceFor(kind: NamespaceKind, region: Region): string {
  return `${kind}-${region}`;
}
