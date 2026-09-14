import { z } from 'zod';

const namedRef = z.object({ id: z.number().int(), name: z.string() });

/**
 * One title a season awarded, and the rating it took.
 *
 * `specialization` and `faction` are each present only where the reward is split
 * that way, and the split differs by bracket and by era: Solo Shuffle is per
 * spec, Blitz is per spec *and* per faction (Marshal and Warlord), rated
 * battlegrounds are per faction, and 3v3 is a single reward today but was split
 * by faction in Shadowlands, with different cutoffs on each side.
 */
export const pvpRewardSchema = z.object({
  bracket: z.object({ id: z.number().int(), type: z.string() }),
  achievement: namedRef,
  rating_cutoff: z.number(),
  specialization: namedRef.optional(),
  faction: z.object({ type: z.string(), name: z.string().optional() }).optional(),
});

export type PvpReward = z.infer<typeof pvpRewardSchema>;

/** GET /data/wow/pvp-season/{seasonId}/pvp-reward/index */
export const pvpRewardIndexSchema = z.object({
  // A season that awarded nothing has nothing to list; absent reads the same.
  rewards: z.array(pvpRewardSchema).default([]),
});

/** GET /data/wow/playable-specialization/{specId} (static namespace) */
export const playableSpecializationSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  playable_class: namedRef,
});
