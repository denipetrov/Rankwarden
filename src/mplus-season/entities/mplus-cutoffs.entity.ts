/** Title tiers Raider.io reports cutoffs for, in the order they are stored. */
export const MPLUS_CUTOFF_TIERS = [
  'keystoneExplorer',
  'keystoneConqueror',
  'keystoneMaster',
  'keystoneHero',
  'keystoneLegend',
  'keystoneMyth',
] as const;

export type MplusCutoffTierName = (typeof MPLUS_CUTOFF_TIERS)[number];

/** Percentile cutoffs stored: the top 0.1% and the top 1% titles. */
export const MPLUS_CUTOFF_QUANTILES = ['p999', 'p990'] as const;

export type MplusCutoffQuantileName = (typeof MPLUS_CUTOFF_QUANTILES)[number];

/**
 * One faction at one cutoff.
 *
 * `minScore` is the figure a player is measured against: the lowest Mythic+
 * score that reaches this cutoff. The population fields say how many characters
 * are at or above it, and out of how many — the size of the faction's ladder in
 * that region, which is also what makes a percentile cutoff meaningful.
 *
 * Fields are nullable because a faction too small to compute a quantile for is
 * reported without one, rather than left out.
 */
export interface MplusCutoffBand {
  /** The quantile reached, 0–1: 0.999 for the top 0.1%. */
  quantile: number | null;
  minScore: number | null;
  populationCount: number | null;
  /** `populationCount / totalPopulation`, 0–1, as Raider.io computes it. */
  populationFraction: number | null;
  totalPopulation: number | null;
}

/**
 * One cutoff, per faction.
 *
 * `score` is the title's own threshold — 2000 for Keystone Master — and is null
 * for the percentile cutoffs, which have no fixed score. `all` is both factions
 * together, and is the figure to show unless a faction is being compared.
 */
export interface MplusCutoff {
  score: number | null;
  alliance: MplusCutoffBand | null;
  horde: MplusCutoffBand | null;
  all: MplusCutoffBand | null;
}

/**
 * Title and percentile cutoffs for one season in one region.
 *
 * Stored on the season's catalogue document under `cutoffs.<region>`, beside
 * the archive marker, so a season carries everything known about it.
 *
 * A tier the season did not award is **absent**, not null: Raider.io reports
 * `keystoneMyth` as null for every season before Midnight, and Taiwan's
 * `season-sl-4` has no Hero, Legend or Myth cutoff at all. Absent therefore
 * means "this season had no such title in this region", which is what a reader
 * needs to know.
 */
export interface MplusSeasonCutoffs {
  /**
   * `ok` — cutoffs were read. Re-read every pass while the season is live, and
   * never again once it is archived.
   * `missing` — Raider.io has none for this season (404). Never asked again:
   * no season before `season-sl-3` has any.
   * `failed` — the request failed and will be tried again on a later tick.
   * `unavailable` — it kept failing and is given up on. `cn` answers 500 rather
   * than 404 for every season before `season-df-4`, so without this the archive
   * would ask again on every tick, for ever.
   */
  status: 'ok' | 'missing' | 'failed' | 'unavailable';
  /** Raider.io's own timestamp for the figures, when it gave one. */
  updatedAt: Date | null;
  /** Title cutoffs, keyed as Raider.io names them. Absent tiers are left out. */
  keystones: Partial<Record<MplusCutoffTierName, MplusCutoff>>;
  /** `p999` is the top 0.1% title, `p990` the top 1%. */
  quantiles: Partial<Record<MplusCutoffQuantileName, MplusCutoff>>;
  fetchedAt: Date;
  /** Failed attempts so far; 0 once read. */
  attempts: number;
  lastError?: string;
}
