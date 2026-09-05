import { z } from 'zod';

const seasonRef = z.object({
  key: z.object({ href: z.string() }).optional(),
  id: z.number().int(),
});

/** GET /data/wow/pvp-season/index */
export const pvpSeasonIndexSchema = z.object({
  seasons: z.array(seasonRef),
  current_season: seasonRef,
  last_completed_season: seasonRef.optional(),
});

export type PvpSeasonIndex = z.infer<typeof pvpSeasonIndexSchema>;

/** GET /data/wow/pvp-season/{seasonId} */
export const pvpSeasonSchema = z.object({
  id: z.number().int(),
  season_start_timestamp: z.number(),
  // Absent while the season is running; Blizzard adds it to this same document
  // once the season ends, which is the only signal that it has.
  season_end_timestamp: z.number().optional(),
  // Observed as a string, absent, and explicitly null across seasons — `.optional()`
  // alone rejects the null and would fail the whole parse.
  season_name: z.string().nullish(),
});

export type PvpSeason = z.infer<typeof pvpSeasonSchema>;
