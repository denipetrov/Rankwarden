import { z } from 'zod';

/**
 * A dungeon as a season lists it.
 *
 * The id is stable across expansions — Black Rook Hold is 7805 in Legion,
 * Shadowlands, Dragonflight and The War Within alike; 31 of the 74 dungeons
 * Raider.io lists recur in more than one expansion — which is what lets the
 * catalogue hold one document per dungeon rather than one per appearance.
 */
const seasonDungeonSchema = z.object({
  id: z.number().int(),
  challenge_mode_id: z.number().int().nullish(),
  slug: z.string(),
  name: z.string(),
  short_name: z.string().nullish(),
  keystone_timer_seconds: z.number().int().nullish(),
  icon_url: z.string().nullish(),
  background_image_url: z.string().nullish(),
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
export type StaticDungeon = z.infer<typeof seasonDungeonSchema>;
export type StaticData = z.infer<typeof staticDataSchema>;
