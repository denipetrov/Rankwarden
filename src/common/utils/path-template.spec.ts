import { describe, expect, it } from 'vitest';

import { fillPath, placeholdersIn } from './path-template.js';

describe('path templates', () => {
  it('lists the placeholders of a template in order', () => {
    expect(placeholdersIn('pvp-season/{seasonId}/pvp-leaderboard/{bracket}')).toEqual([
      'seasonId',
      'bracket',
    ]);
    expect(placeholdersIn('pvp-season/index')).toEqual([]);
  });

  it('fills every placeholder', () => {
    expect(
      fillPath('pvp-season/{seasonId}/pvp-leaderboard/{bracket}', { seasonId: 42, bracket: '3v3' }),
    ).toBe('pvp-season/42/pvp-leaderboard/3v3');
  });

  it('returns a template with no placeholders unchanged', () => {
    expect(fillPath('mythic-plus/runs')).toBe('mythic-plus/runs');
  });

  it('inserts values as given, leaving encoding to the caller', () => {
    expect(fillPath('character/{name}', { name: 'z%C3%ABph' })).toBe('character/z%C3%ABph');
  });

  it('throws on a placeholder with no value rather than sending it literally', () => {
    expect(() => fillPath('pvp-season/{seasonId}', {})).toThrow(/\{seasonId\}/);
  });
});
