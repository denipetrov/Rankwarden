import { z } from 'zod';

import { REGIONS } from '../../blizzard/blizzard.constants.js';

const namedRef = z.object({ id: z.number().int(), name: z.string() });

const bracketStats = z.object({
  rank: z.number().int(),
  rating: z.number().int(),
  played: z.number().int().nonnegative().default(0),
  won: z.number().int().nonnegative().default(0),
  lost: z.number().int().nonnegative().default(0),
  fetchedAt: z.coerce.date().optional(),
});

/**
 * Every field is optional and carries no default: an absent field leaves what is
 * stored untouched, while an explicit `null` clears it. Defaults here would
 * fabricate nulls for fields the caller simply did not mention and overwrite good
 * data with them.
 */
const profile = z.object({
  race: namedRef.optional(),
  class: namedRef.optional(),
  spec: namedRef.nullable().optional(),
  heroTalentTree: namedRef.nullable().optional(),
  talentLoadouts: z
    .array(
      z.object({
        spec: namedRef,
        talentLoadoutCode: z.string().nullable().default(null),
        heroTalentTree: namedRef.nullable().default(null),
      }),
    )
    .optional(),
  level: z.number().int().optional(),
  gender: z.string().nullable().optional(),
  guild: namedRef.nullable().optional(),
  realmName: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  averageItemLevel: z.number().int().nullable().optional(),
  equippedItemLevel: z.number().int().nullable().optional(),
  lastLoginAt: z.coerce.date().nullable().optional(),
});

/**
 * A whole character record as this service stores it.
 *
 * `ratings` is deliberately not accepted: it is a derived mirror of `brackets`,
 * and recomputing it here is the only way the two cannot drift. Unknown keys —
 * `_id`, `ratings`, the enrichment timestamps — are dropped, so a caller can
 * round-trip a document it read straight back in.
 */
export const characterSyncSchema = z.object({
  seasonId: z.number().int().positive(),
  region: z.enum(REGIONS),
  characterId: z.number().int().positive(),
  characterName: z.string().min(1),
  realmId: z.number().int(),
  realmSlug: z.string().min(1),
  faction: z.string().nullable().default(null),
  brackets: z.record(z.string().min(1), bracketStats),
  profile: profile.optional(),
});

export type CharacterSyncInput = z.infer<typeof characterSyncSchema>;
