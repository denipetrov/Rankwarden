import { z } from 'zod';

/**
 * Raider.io's `{ id, name, slug }` reference, which most nested objects use.
 * `slug` is absent on some (weekly modifiers carry one, roles do not), so only
 * id and name are required.
 */
const namedRefSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string().optional(),
});

/**
 * A realm as Raider.io reports it.
 *
 * `wowRealmId` is Blizzard's realm id — verified against the Blizzard profile
 * API for four realms (stormrage 60, area-52 1566, zuljin 61, illidan 57) — and
 * is the only field here that means anything outside Raider.io. It is
 * **optional** because anonymised characters carry a placeholder realm that
 * omits it entirely, along with `altName`, `locale` and `realmType`. A schema
 * requiring it fails the whole page, and about one roster entry in two hundred
 * is anonymised, so every page would fail.
 */
const realmSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  wowRealmId: z.number().int().optional(),
  wowConnectedRealmId: z.number().int().optional(),
  connectedRealmId: z.number().int().optional(),
  altName: z.string().nullish(),
  altSlug: z.string().nullish(),
  locale: z.string().optional(),
  isConnected: z.boolean().optional(),
  realmType: z.string().optional(),
  anonymized: z.boolean().optional(),
});

/**
 * A character in a run's roster.
 *
 * `id` is **Raider.io's own** character id, not Blizzard's: cross-checked
 * against the Blizzard profile API, exxibae-stormrage is 258653729 to Blizzard
 * and 228420218 to Raider.io. The two id spaces overlap in magnitude, which is
 * what makes storing one where the other is expected fail silently rather than
 * loudly. It is also `0` for every anonymised character, so it is not a usable
 * identity on its own — see `MplusCharacterDocument`.
 */
const rosterCharacterSchema = z.object({
  id: z.number().int(),
  persona_id: z.number().int().optional(),
  name: z.string(),
  class: namedRefSchema,
  race: namedRefSchema.extend({ faction: z.string().optional() }).nullish(),
  spec: namedRefSchema.nullish(),
  faction: z.string().nullish(),
  level: z.number().int().nullish(),
  path: z.string().optional(),
  realm: realmSchema,
  region: z.object({ name: z.string(), slug: z.string(), short_name: z.string().optional() }),
  anonymized: z.boolean().optional(),
});

const rosterEntrySchema = z.object({
  character: rosterCharacterSchema,
  role: z.string(),
  /** Null when the run was logged without an importable talent string. */
  loadout: z.string().nullish(),
  isTransfer: z.boolean().optional(),
  isBanned: z.boolean().optional(),
});

/** A weekly affix. Names and descriptions are stored once, in `mplus_affixes`. */
export const weeklyModifierSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
});

const dungeonSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  slug: z.string(),
  short_name: z.string().optional(),
  keystone_timer_ms: z.number().int().optional(),
  num_bosses: z.number().int().optional(),
  map_challenge_mode_id: z.number().int().optional(),
});

const runSchema = z.object({
  keystone_run_id: z.number().int(),
  season: z.string(),
  status: z.string(),
  dungeon: dungeonSchema,
  mythic_level: z.number().int(),
  clear_time_ms: z.number().int(),
  keystone_time_ms: z.number().int().nullish(),
  completed_at: z.string(),
  num_chests: z.number().int().nullish(),
  /** Negative when a key was depleted. The leaderboard only lists timed runs. */
  time_remaining_ms: z.number().nullish(),
  weekly_modifiers: z.array(weeklyModifierSchema),
  faction: z.string().nullish(),
  deleted_at: z.string().nullish(),
  roster: z.array(rosterEntrySchema),
});

export const mythicPlusRankingSchema = z.object({
  rank: z.number().int(),
  score: z.number(),
  run: runSchema,
});

/**
 * One page of the `/mythic-plus/runs` leaderboard.
 *
 * `rankings` is empty rather than absent past the end of the data, and page
 * 1001 is a 400 rather than an empty page — both handled by the caller.
 */
export const mythicPlusRunsSchema = z.object({
  rankings: z.array(mythicPlusRankingSchema),
  leaderboard_url: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export type MythicPlusRunsPage = z.infer<typeof mythicPlusRunsSchema>;
export type MythicPlusRanking = z.infer<typeof mythicPlusRankingSchema>;
export type MythicPlusRosterEntry = z.infer<typeof rosterEntrySchema>;
export type WeeklyModifier = z.infer<typeof weeklyModifierSchema>;
