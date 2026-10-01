import { z } from 'zod';

/** A boss, as its raid lists it. */
const raidEncounterSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
});

/**
 * Per-region raid boundaries, keyed by region slug rather than a fixed shape:
 * the regions Raider.io publishes are its own list (`cn` included), and a new
 * one appearing must not fail the parse of every raid.
 */
const regionTimestampsSchema = z.record(z.string(), z.string());

/**
 * One raid, as `/raiding/static-data` lists it.
 *
 * `id` is the raid's own id and is unique across every expansion — the
 * identity the catalogue stores by. A re-release is a raid of its own, not a
 * flag on the original: Fated Castle Nathria is `100013224` to Castle
 * Nathria's `13224`, with its own slug and its own dates.
 *
 * Permissive about everything but identity, as the other Raider.io schemas
 * are. `icon` is absent on every raid before Shadowlands; a raid still open is
 * listed with the same `2030-01-01` placeholder end a running Mythic+ season
 * carries.
 */
export const staticRaidSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  short_name: z.string().nullish(),
  icon: z.string().nullish(),
  starts: regionTimestampsSchema.nullish(),
  ends: regionTimestampsSchema.nullish(),
  encounters: z.array(raidEncounterSchema).nullish(),
});

export const raidStaticDataSchema = z.object({
  raids: z.array(staticRaidSchema),
});

export type StaticRaid = z.infer<typeof staticRaidSchema>;
export type StaticRaidEncounter = z.infer<typeof raidEncounterSchema>;
export type RaidStaticData = z.infer<typeof raidStaticDataSchema>;
