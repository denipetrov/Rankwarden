import type { Region, RatingFamily } from '../../blizzard/blizzard.constants.js';

/** One hero talent tree's share within a single specialisation. */
export interface HeroTalentShare {
  id: number;
  /** Display name, e.g. "Shado-Pan" — hero trees have no bracket slug to match. */
  name: string;
  count: number;
  /** Fraction of the spec's `heroTalentsClassified`, 0–1. */
  share: number;
}

/** One specialisation's share of a bracket at a rating cutoff. */
export interface SpecShare {
  /** Slug matching Blizzard's bracket naming, e.g. "deathknight". */
  class: string;
  /** Slug matching Blizzard's bracket naming, e.g. "beastmastery". */
  spec: string;
  count: number;
  /** Fraction of `classified`, 0–1. */
  share: number;
  /**
   * Of this spec's `count`, how many had a known hero talent tree. Always needs
   * an enriched profile — the bracket name carries class and spec but not the
   * hero tree — so this trails `count` until enrichment has covered the ladder.
   */
  heroTalentsClassified: number;
  /** Descending by count; shares are of `heroTalentsClassified`, not of `count`. */
  heroTalents: HeroTalentShare[];
}

/**
 * A daily snapshot of which specs are being played in a bracket above a rating
 * cutoff — the "flavour of the month" curve, one row per day per cutoff.
 */
export interface SpecRepresentationDocument {
  /** UTC midnight of the day this describes. */
  date: Date;
  seasonId: number;
  region: Region;
  family: RatingFamily;
  minRating: number;
  /** Characters or rows at or above the cutoff. */
  total: number;
  /**
   * How many of `total` had a known specialisation. For shuffle and blitz this
   * equals `total`, because the bracket name carries the spec. For 2v2, 3v3 and
   * rbg it depends on profile enrichment coverage, so a snapshot where
   * `classified` is far below `total` is not yet representative.
   */
  classified: number;
  specs: SpecShare[];
  computedAt: Date;
}

export const SPEC_REPRESENTATION_COLLECTION = 'spec_representation';

/** Blizzard's own bracket slugs: lowercase, letters only ("Death Knight" -> "deathknight"). */
export function toSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z]/g, '');
}

/** UTC midnight, so a day means the same thing regardless of where this runs. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
