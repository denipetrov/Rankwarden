import { describe, expect, it } from 'vitest';

import {
  activeLoadoutsBySpec,
  characterSpecializationsSchema,
} from './character-profile.schema.js';

/**
 * Shaped after a real payload: the character is playing Windwalker, and every
 * specialisation carries its own active loadout.
 */
const payload = characterSpecializationsSchema.parse({
  active_specialization: { id: 269, name: 'Windwalker' },
  active_hero_talent_tree: { id: 65, name: 'Shado-Pan' },
  specializations: [
    {
      specialization: { id: 268, name: 'Brewmaster' },
      loadouts: [
        { is_active: true, talent_loadout_code: 'BREWMASTER-ACTIVE' },
        { is_active: false, talent_loadout_code: 'BREWMASTER-OTHER' },
      ],
    },
    {
      specialization: { id: 269, name: 'Windwalker' },
      loadouts: [
        { is_active: false, talent_loadout_code: 'WINDWALKER-OTHER' },
        { is_active: true, talent_loadout_code: 'WINDWALKER-ACTIVE' },
        { is_active: false, talent_loadout_code: 'WINDWALKER-THIRD' },
      ],
    },
  ],
});

describe('activeLoadoutsBySpec', () => {
  it('returns the active loadout for every spec, paired with its spec', () => {
    expect(activeLoadoutsBySpec(payload)).toEqual([
      { spec: { id: 268, name: 'Brewmaster' }, talentLoadoutCode: 'BREWMASTER-ACTIVE' },
      { spec: { id: 269, name: 'Windwalker' }, talentLoadoutCode: 'WINDWALKER-ACTIVE' },
    ]);
  });

  it('keeps each code with its own spec rather than mixing builds', () => {
    const byName = new Map(
      activeLoadoutsBySpec(payload).map((entry) => [entry.spec.name, entry.talentLoadoutCode]),
    );

    expect(byName.get('Windwalker')).toBe('WINDWALKER-ACTIVE');
    expect(byName.get('Brewmaster')).toBe('BREWMASTER-ACTIVE');
  });

  it('lets the caller find the build being played via the active spec id', () => {
    const played = activeLoadoutsBySpec(payload).find(
      (entry) => entry.spec.id === payload.active_specialization?.id,
    );

    expect(played?.talentLoadoutCode).toBe('WINDWALKER-ACTIVE');
  });

  it('omits specs whose loadouts are all inactive', () => {
    const parsed = characterSpecializationsSchema.parse({
      active_specialization: { id: 269, name: 'Windwalker' },
      specializations: [
        {
          specialization: { id: 269, name: 'Windwalker' },
          loadouts: [{ is_active: false, talent_loadout_code: 'UNUSED' }],
        },
      ],
    });

    expect(activeLoadoutsBySpec(parsed)).toEqual([]);
  });

  it('omits an active loadout that carries no talent code', () => {
    const parsed = characterSpecializationsSchema.parse({
      active_specialization: { id: 269, name: 'Windwalker' },
      specializations: [
        { specialization: { id: 269, name: 'Windwalker' }, loadouts: [{ is_active: true }] },
      ],
    });

    expect(activeLoadoutsBySpec(parsed)).toEqual([]);
  });

  it('returns an empty list when the payload carries no specialisations', () => {
    expect(activeLoadoutsBySpec(characterSpecializationsSchema.parse({}))).toEqual([]);
  });
});
