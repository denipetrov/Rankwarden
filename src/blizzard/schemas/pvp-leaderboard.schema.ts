import { z } from 'zod';

const realmSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
});

const characterSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  realm: realmSchema,
});

const matchStatisticsSchema = z.object({
  played: z.number().int(),
  won: z.number().int(),
  lost: z.number().int(),
});

export const pvpLeaderboardEntrySchema = z.object({
  character: characterSchema,
  faction: z.object({ type: z.string() }).optional(),
  rank: z.number().int(),
  rating: z.number().int(),
  season_match_statistics: matchStatisticsSchema.optional(),
});

/** GET /data/wow/pvp-season/{seasonId}/pvp-leaderboard/{bracket} */
export const pvpLeaderboardSchema = z.object({
  season: z.object({ id: z.number().int() }),
  name: z.string(),
  bracket: z.object({ id: z.number().int(), type: z.string() }),
  entries: z.array(pvpLeaderboardEntrySchema).default([]),
});

export type PvpLeaderboard = z.infer<typeof pvpLeaderboardSchema>;
export type PvpLeaderboardEntry = z.infer<typeof pvpLeaderboardEntrySchema>;
