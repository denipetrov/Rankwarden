import { z } from 'zod';

/**
 * The guild a ranking entry is about.
 *
 * `region` is the guild's own, which on the `world` board is not the board's:
 * that list mixes every region, `cn` included. `logo` is always present — a
 * guild that never uploaded one carries a default faction icon — but nothing
 * here depends on that.
 */
const rankedGuildSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  faction: z.string().nullish(),
  logo: z.string().nullish(),
  region: z.object({ slug: z.string() }).nullish(),
  realm: z
    .object({
      slug: z.string().nullish(),
      name: z.string().nullish(),
    })
    .nullish(),
});

/**
 * One boss a guild has pulled.
 *
 * `id` is deliberately not read: it is not the encounter's id from the static
 * data (`470105` against an encounter id in the 200,000s) but a record of the
 * guild's own progress, so the boss is identified by `slug`, which matches the
 * raid's encounter slugs on every raid listed (checked live, 2026-10-02).
 *
 * `numPulls` and `pullStartedAt` are absent for a guild that restricts its pull
 * counts; `bestPercent` is the boss health left on the best attempt — `0` once
 * defeated, sometimes null.
 */
const encounterPulledSchema = z.object({
  slug: z.string(),
  numPulls: z.number().nullish(),
  pullStartedAt: z.string().nullish(),
  bestPercent: z.number().nullish(),
  isDefeated: z.boolean().nullish(),
});

/** One boss a guild has killed, with when. */
const encounterDefeatedSchema = z.object({
  slug: z.string(),
  firstDefeated: z.string().nullish(),
  lastDefeated: z.string().nullish(),
});

/**
 * One ranked guild, as `/raiding/raid-rankings` lists it.
 *
 * `rank` is the place on the board asked for and `regionRank` the place within
 * the guild's own region — the same number on a region's board, different on
 * `world`. Ranks are taken as served, never from the position in the list: a
 * board can skip a rank (The Emerald Nightmare's top 100 has 97 entries).
 *
 * `encountersPulled` is empty for every guild on a raid older than Shadowlands
 * and for a guild that hides its pulls, so `encountersDefeated` is the only
 * record of progress those entries carry.
 */
export const raidRankingSchema = z.object({
  rank: z.number().int(),
  regionRank: z.number().int().nullish(),
  guild: rankedGuildSchema,
  encountersPulled: z.array(encounterPulledSchema).nullish(),
  encountersDefeated: z.array(encounterDefeatedSchema).nullish(),
});

export const raidRankingsSchema = z.object({
  raidRankings: z.array(raidRankingSchema),
});

export type RaidRanking = z.infer<typeof raidRankingSchema>;
export type RaidRankings = z.infer<typeof raidRankingsSchema>;
