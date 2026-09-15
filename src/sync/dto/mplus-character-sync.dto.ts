import { z } from 'zod';

import { RAIDERIO_REGIONS } from '../../raiderio/raiderio.constants.js';

const dungeonRef = z.object({
  id: z.number().int(),
  name: z.string().min(1),
  slug: z.string().min(1),
  shortName: z.string().nullable().default(null),
});

const dungeonRun = z.object({
  dungeon: dungeonRef,
  keystoneRunId: z.number().int(),
  mythicLevel: z.number().int().positive(),
  score: z.number().nonnegative(),
  clearTimeMs: z.number().int().nonnegative(),
  timeRemainingMs: z.number().nullable().default(null),
  numChests: z.number().int().nullable().default(null),
  completedAt: z.coerce.date(),
  specId: z.number().int().nullable().default(null),
  role: z.string().min(1),
});

/**
 * Every field is optional and carries no default, for the same reason the PvP
 * profile is: an absent field leaves what is stored untouched, while an explicit
 * `null` clears it. Defaults here would fabricate nulls for fields the caller
 * simply did not mention and overwrite good data with them.
 */
const profile = z.object({
  classId: z.number().int().optional(),
  className: z.string().optional(),
  specId: z.number().int().nullable().optional(),
  specName: z.string().nullable().optional(),
  raceId: z.number().int().nullable().optional(),
  raceName: z.string().nullable().optional(),
  level: z.number().int().nullable().optional(),
  role: z.string().nullable().optional(),
});

/**
 * A Mythic+ character record as this service stores it.
 *
 * `mythicScore` and `dungeonsCovered` are deliberately **not accepted**: they are
 * derived from `dungeonRuns`, and recomputing them here is the only way the
 * three cannot drift — exactly the rule `ratings` follows on the PvP side. Nor
 * is `key`, which is built from the identity fields. Unknown keys are dropped,
 * so a caller can round-trip a document it read straight back in.
 */
export const mplusCharacterSyncSchema = z.object({
  season: z.string().min(1),
  region: z.enum(RAIDERIO_REGIONS),
  realmSlug: z.string().min(1),
  characterName: z.string().min(1),
  seasonId: z.number().int().nullable().optional(),
  rioCharacterId: z.number().int().nullable().optional(),
  realmId: z.number().int().nullable().optional(),
  realmName: z.string().nullable().optional(),
  faction: z.string().nullable().optional(),
  dungeonRuns: z.array(dungeonRun),
  profile: profile.optional(),
});

export type MplusCharacterSyncInput = z.infer<typeof mplusCharacterSyncSchema>;
