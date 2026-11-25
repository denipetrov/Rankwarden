import { z } from 'zod';

import { RAIDERIO_REGIONS } from '../../raiderio/raiderio.constants.js';

/**
 * Hides or shows a player or a guild.
 *
 * A player is named by region, realm and name, as the game shows them, and is
 * hidden in both PvP and Mythic+ — every season, including ones not yet
 * started. The region list is Mythic+'s, which includes `cn`. A guild is named
 * by its Raider.io id.
 */
export const setHiddenSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('character'),
    region: z.enum(RAIDERIO_REGIONS),
    realmSlug: z.string().trim().min(1),
    name: z.string().trim().min(1),
    hidden: z.boolean(),
  }),
  z.object({
    kind: z.literal('guild'),
    guildId: z.number().int().positive(),
    hidden: z.boolean(),
  }),
]);

export type SetHiddenInput = z.infer<typeof setHiddenSchema>;
