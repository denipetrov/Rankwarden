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
  realm: z.object({ id: z.number().int(), name: z.string(), slug: z.string() }),
  // e.g. "Galactic Gladiator {name}". Absent when no title is equipped.
  active_title: namedRef.extend({ display_string: z.string() }).optional(),
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
  // Only the fields we keep; zod drops the rest of the payload, which carries a
  // full talent tree with tooltips for every loadout.
  specializations: z
    .array(
      z.object({
        specialization: namedRef,
        loadouts: z
          .array(
            z.object({
              is_active: z.boolean(),
              talent_loadout_code: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

export type CharacterProfilePayload = z.infer<typeof characterProfileSchema>;
export type CharacterSpecializationsPayload = z.infer<typeof characterSpecializationsSchema>;

/**
 * The importable talent code of the active loadout for each specialisation the
 * character has built, so a UI can switch builds as it filters by spec.
 *
 * Every specialisation carries its own `is_active` loadout, so each code stays
 * paired with the spec it belongs to. Specs with no active loadout, or an active
 * loadout Blizzard reports without a code, are left out — there is nothing to
 * link to.
 */
export function activeLoadoutsBySpec(
  payload: CharacterSpecializationsPayload,
): { spec: { id: number; name: string }; talentLoadoutCode: string }[] {
  return (payload.specializations ?? []).flatMap((entry) => {
    const code = entry.loadouts?.find((loadout) => loadout.is_active)?.talent_loadout_code;

    return code ? [{ spec: entry.specialization, talentLoadoutCode: code }] : [];
  });
}
