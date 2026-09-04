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
export const CORE_BRACKETS = ['2v2', '3v3', 'rbg'] as const;

/**
 * Aggregate ladders Blizzard publishes next to the per-spec ones. Solo Shuffle
 * and Blitz are rated per specialisation, and the "overall" board does not track
 * a character's best spec: it can sit well below their strongest rating (one
 * character ranks 1st in shuffle-mage-fire at 2688 while their overall reads
 * 2454, their frost rating). Ingesting them would mean storing a rating that
 * contradicts the per-spec data, so they are skipped entirely.
 */
export const EXCLUDED_BRACKETS = ['shuffle-overall', 'blitz-overall'] as const;

/**
 * Ladder families that are rated per specialisation, so a character can hold
 * several ratings at once. Each gets its own flat ratings collection, which is
 * what an "all classes, all specs" board is ordered from.
 */
export const SPEC_SPLIT_FAMILIES = ['shuffle', 'blitz'] as const;
export type SpecSplitFamily = (typeof SPEC_SPLIT_FAMILIES)[number];

/** The family a bracket belongs to, or null for the single-rating ladders. */
export function specSplitFamilyOf(bracket: Bracket): SpecSplitFamily | null {
  return SPEC_SPLIT_FAMILIES.find((family) => bracket.startsWith(`${family}-`)) ?? null;
}

export function isIngestableBracket(bracket: Bracket): boolean {
  return !(EXCLUDED_BRACKETS as readonly string[]).includes(bracket);
}

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
