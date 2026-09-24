import type {
  SeasonCutoffBand,
  SeasonCutoffEntry,
  SeasonCutoffs,
} from '../raiderio/schemas/season-cutoffs.schema.js';
import {
  MPLUS_CUTOFF_QUANTILES,
  MPLUS_CUTOFF_TIERS,
  type MplusCutoff,
  type MplusCutoffBand,
  type MplusCutoffQuantileName,
  type MplusCutoffTierName,
  type MplusSeasonCutoffs,
} from './entities/mplus-cutoffs.entity.js';

function toBand(band: SeasonCutoffBand | null | undefined): MplusCutoffBand | null {
  if (!band) return null;

  return {
    quantile: band.quantile ?? null,
    minScore: band.quantileMinValue ?? null,
    populationCount: band.quantilePopulationCount ?? null,
    populationFraction: band.quantilePopulationFraction ?? null,
    totalPopulation: band.totalPopulationCount ?? null,
  };
}

/**
 * One cutoff, or null when the season had none.
 *
 * A cutoff with no faction at all counts as none: Raider.io reports a tier that
 * did not exist as `null`, and one with every faction empty says the same thing
 * in a different shape.
 */
function toCutoff(entry: SeasonCutoffEntry | null | undefined): MplusCutoff | null {
  if (!entry) return null;

  const cutoff: MplusCutoff = {
    score: entry.score ?? null,
    alliance: toBand(entry.alliance),
    horde: toBand(entry.horde),
    all: toBand(entry.all),
  };

  if (!cutoff.alliance && !cutoff.horde && !cutoff.all) return null;

  return cutoff;
}

/** Raider.io's `Mon Jan 19 2026 22:41:01 GMT+0000 (…)`, or null if unparseable. */
function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;

  const at = Date.parse(value);

  return Number.isFinite(at) ? new Date(at) : null;
}

/**
 * The cutoffs a season and region are stored with.
 *
 * Only the tiers and the two percentiles worth keeping: the payload also
 * carries `p900`, `p750`, `p600`, `graphData` and a count of every timed key
 * from +2 to +29, none of which a board needs. Tiers the season did not award
 * are left out entirely (see `MplusSeasonCutoffs`).
 */
export function toSeasonCutoffs(cutoffs: SeasonCutoffs, fetchedAt: Date): MplusSeasonCutoffs {
  const keystones: Partial<Record<MplusCutoffTierName, MplusCutoff>> = {};
  const quantiles: Partial<Record<MplusCutoffQuantileName, MplusCutoff>> = {};

  for (const tier of MPLUS_CUTOFF_TIERS) {
    const cutoff = toCutoff(cutoffs[tier]);
    if (cutoff) keystones[tier] = cutoff;
  }

  for (const quantile of MPLUS_CUTOFF_QUANTILES) {
    const cutoff = toCutoff(cutoffs[quantile]);
    if (cutoff) quantiles[quantile] = cutoff;
  }

  return {
    status: 'ok',
    updatedAt: toDate(cutoffs.updatedAt),
    keystones,
    quantiles,
    fetchedAt,
    attempts: 0,
  };
}
