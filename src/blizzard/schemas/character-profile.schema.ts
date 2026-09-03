import { z } from 'zod';

/** Blizzard's ubiquitous { key, name, id } reference, keeping only what we store. */
const namedRef = z.object({ id: z.number().int(), name: z.string() });

/** GET /profile/wow/character/{realmSlug}/{characterName} */
export const characterProfileSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  level: z.number().int(),
  race: namedRef,
  character_class: namedRef,
  active_spec: namedRef.optional(),
  faction: z.object({ type: z.string(), name: z.string() }).optional(),
  gender: z.object({ type: z.string(), name: z.string() }).optional(),
  guild: namedRef.optional(),
  average_item_level: z.number().int().optional(),
  equipped_item_level: z.number().int().optional(),
  last_login_timestamp: z.number().optional(),
});

/**
 * GET /profile/wow/character/{realmSlug}/{characterName}/specializations
 *
 * `active_hero_talent_tree` is the tree on the active loadout — verified to
 * match `loadouts[is_active].selected_hero_talent_tree`, so the deep loadout
 * walk is unnecessary.
 */
export const characterSpecializationsSchema = z.object({
  active_specialization: namedRef.optional(),
  active_hero_talent_tree: namedRef.optional(),
});

export type CharacterProfilePayload = z.infer<typeof characterProfileSchema>;
export type CharacterSpecializationsPayload = z.infer<typeof characterSpecializationsSchema>;
