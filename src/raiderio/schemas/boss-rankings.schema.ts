import { z } from 'zod';

import { rankedGuildSchema } from './raid-rankings.schema.js';

/**
 * One kill of the boss by the guild.
 *
 * Every kill is listed, oldest first (checked live, 2026-11-02, on every entry
 * of seven boards); `attempts` is the pulls before that kill, and is null for
 * a good share of kills and for every kill of a raid before Shadowlands.
 */
const bossKillSchema = z.object({
  slug: z.string(),
  firstDefeated: z.string().nullish(),
  lastDefeated: z.string().nullish(),
  attempts: z.number().nullish(),
});

/**
 * One ranked guild, as `/raiding/boss-rankings` lists it.
 *
 * Fifty at most, best first, in one answer: the endpoint takes no `page` or
 * `limit` (either is a 400). A guild still progressing on the boss is listed
 * after the ones that killed it, with no kills (`isAttemptOnly`). The rest of
 * what is served — streamers, recruitment, video — is not read.
 */
export const bossRankingSchema = z.object({
  rank: z.number().int(),
  guild: rankedGuildSchema,
  itemLevelAvg: z.number().nullish(),
  encountersDefeated: z.array(bossKillSchema).nullish(),
});

/**
 * The board. A rank upstream will not show is served as `null` in its place —
 * Garothi Worldbreaker's Mythic board in `eu` has `null` at rank 18 (checked
 * live, 2026-11-02) — so a `null` is dropped, not taken for a broken answer:
 * read as one, it failed the board and three such boards in a row ended a
 * run. The ranks of the entries kept are as served, so the gap stays visible.
 */
export const bossRankingsSchema = z.object({
  bossRankings: z
    .array(bossRankingSchema.nullable())
    .transform((entries) => entries.filter((entry) => entry !== null)),
});

export type BossRanking = z.infer<typeof bossRankingSchema>;
