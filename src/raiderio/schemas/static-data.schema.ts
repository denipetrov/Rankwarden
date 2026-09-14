import { z } from 'zod';

const seasonDungeonSchema = z.object({
  id: z.number().int(),
  challenge_mode_id: z.number().int().optional(),
  slug: z.string(),
  name: z.string(),
  short_name: z.string().optional(),
  keystone_timer_seconds: z.number().int().optional(),
});

/**
 * Per-region season boundaries.
 *
 * Keyed by region slug rather than a fixed shape, because the set of regions
 * Raider.io publishes here is its own list (`cn` included) and a new one
 * appearing must not fail the parse of every season.
 */
const regionTimestampsSchema = z.record(z.string(), z.string());

export const staticSeasonSchema = z.object({
  slug: z.string(),
  name: z.string(),
  short_name: z.string().optional(),
  /**
   * Blizzard's M+ season id, which is **not** the PvP season id: M+ season 2 of
   * Midnight is 18 here while the live PvP season is 42. Stored for reference
   * only — nothing keys off it.
   */
  blizzard_season_id: z.number().int().nullish(),
  /**
   * False for side events like `season-mn-1-break-the-meta`, which overlap a
   * real season and would otherwise look like the current one.
   */
  is_main_season: z.boolean().optional(),
  seasonal_affix: z.unknown().nullish(),
  starts: regionTimestampsSchema.optional(),
  ends: regionTimestampsSchema.optional(),
  dungeons: z.array(seasonDungeonSchema).optional(),
});

export const staticDataSchema = z.object({
  seasons: z.array(staticSeasonSchema),
  dungeons: z.array(seasonDungeonSchema).optional(),
});

export type StaticSeason = z.infer<typeof staticSeasonSchema>;
export type StaticData = z.infer<typeof staticDataSchema>;
