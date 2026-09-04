/** Regions served by the global Blizzard Game Data API (CN uses a separate host). */
export const REGIONS = ['us', 'eu', 'kr', 'tw'] as const;
export type Region = (typeof REGIONS)[number];

/**
 * Bracket names come from Blizzard's per-season leaderboard index — currently 85
 * of them (the five below plus a shuffle and blitz ladder for every spec), and
 * the set changes as specs are added. Treated as opaque strings for that reason.
 */
export type Bracket = string;

/** The headline brackets, called out for reporting and for the API's defaults. */
export const CORE_BRACKETS = ['2v2', '3v3', 'rbg', 'shuffle-overall', 'blitz-overall'] as const;

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
