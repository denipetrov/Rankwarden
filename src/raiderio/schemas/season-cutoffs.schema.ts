import { z } from 'zod';

/**
 * One faction's standing at a cutoff: the score that reaches it, and how many
 * characters are at or above it.
 *
 * Every numeric field is `nullish`, because a faction with too few characters
 * to compute a quantile is reported as `null` rather than omitted — Taiwan and
 * Korea both have seasons like that.
 */
const cutoffBandSchema = z.object({
  quantile: z.number().nullish(),
  quantileMinValue: z.number().nullish(),
  quantilePopulationCount: z.number().nullish(),
  quantilePopulationFraction: z.number().nullish(),
  totalPopulationCount: z.number().nullish(),
});

/**
 * One cutoff, per faction.
 *
 * `score` is the title's own threshold (2000 for Keystone Master) and is absent
 * from the percentile cutoffs, which have no fixed score.
 */
const cutoffEntrySchema = z.object({
  score: z.number().nullish(),
  alliance: cutoffBandSchema.nullish(),
  horde: cutoffBandSchema.nullish(),
  all: cutoffBandSchema.nullish(),
});

/**
 * `mythic-plus/season-cutoffs` for one season and region.
 *
 * Deliberately permissive. The payload carries far more than is stored —
 * `p900`, `p750`, `p600`, `graphData`, `allTimed2..29`, per-faction colours —
 * and Raider.io adds keys as titles change (`keystoneMyth` arrived with
 * Midnight). A whole **tier** is `null` for a season that had no such title, so
 * every tier is `nullish` and read as "the season had none".
 */
export const seasonCutoffsSchema = z.object({
  cutoffs: z
    .object({
      updatedAt: z.string().nullish(),
      p999: cutoffEntrySchema.nullish(),
      p990: cutoffEntrySchema.nullish(),
      keystoneMyth: cutoffEntrySchema.nullish(),
      keystoneLegend: cutoffEntrySchema.nullish(),
      keystoneHero: cutoffEntrySchema.nullish(),
      keystoneMaster: cutoffEntrySchema.nullish(),
      keystoneConqueror: cutoffEntrySchema.nullish(),
      keystoneExplorer: cutoffEntrySchema.nullish(),
    })
    .passthrough(),
});

export type SeasonCutoffs = z.infer<typeof seasonCutoffsSchema>['cutoffs'];
export type SeasonCutoffEntry = z.infer<typeof cutoffEntrySchema>;
export type SeasonCutoffBand = z.infer<typeof cutoffBandSchema>;
