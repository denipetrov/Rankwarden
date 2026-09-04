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
              selected_hero_talent_tree: namedRef.optional(),
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
 * The active loadout of each specialisation the character has built.
 *
 * Every specialisation carries its own `is_active` loadout, so the talent code
 * and the hero talent tree both stay paired with the spec they belong to. That
 * pairing matters beyond deep-linking: a Fury warrior who also plays the Arms
 * ladder has a Fury hero tree that says nothing about their Arms build, and
 * attributing it to Arms produces combinations the game does not allow.
 *
 * Specs with no active loadout are left out; one whose loadout has no importable
 * code is kept, because its hero tree is still worth knowing.
 */
export function activeLoadoutsBySpec(payload: CharacterSpecializationsPayload): {
  spec: { id: number; name: string };
  talentLoadoutCode: string | null;
  heroTalentTree: { id: number; name: string } | null;
}[] {
  return (payload.specializations ?? []).flatMap((entry) => {
    const active = entry.loadouts?.find((loadout) => loadout.is_active);
    if (!active) return [];

    return [
      {
        spec: entry.specialization,
        talentLoadoutCode: active.talent_loadout_code ?? null,
        heroTalentTree: active.selected_hero_talent_tree ?? null,
      },
    ];
  });
}
