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
