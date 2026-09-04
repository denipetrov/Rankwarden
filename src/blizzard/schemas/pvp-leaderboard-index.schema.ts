import { z } from 'zod';

/** GET /data/wow/pvp-season/{seasonId}/pvp-leaderboard/index */
export const pvpLeaderboardIndexSchema = z.object({
  // Only the first entry carries an `id`; the name is the path segment anyway.
  leaderboards: z.array(z.object({ name: z.string(), id: z.number().int().optional() })),
});

export type PvpLeaderboardIndex = z.infer<typeof pvpLeaderboardIndexSchema>;
