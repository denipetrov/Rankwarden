import { describe, expect, it } from 'vitest';

import { EXCLUDED_BRACKETS, isIngestableBracket, specSplitFamilyOf } from './blizzard.constants.js';

describe('isIngestableBracket', () => {
  it('accepts the rated ladders', () => {
    for (const bracket of ['2v2', '3v3', 'rbg']) {
      expect(isIngestableBracket(bracket)).toBe(true);
    }
  });

  it('accepts per-specialisation shuffle and blitz ladders', () => {
    expect(isIngestableBracket('shuffle-mage-fire')).toBe(true);
    expect(isIngestableBracket('blitz-warrior-arms')).toBe(true);
  });

  it('rejects the aggregate ladders, whose rating contradicts the per-spec data', () => {
    expect(isIngestableBracket('shuffle-overall')).toBe(false);
    expect(isIngestableBracket('blitz-overall')).toBe(false);
  });

  it('rejects exactly the excluded list and nothing else', () => {
    expect(EXCLUDED_BRACKETS.filter((bracket) => isIngestableBracket(bracket))).toEqual([]);
  });
});

describe('specSplitFamilyOf', () => {
  it('maps per-spec ladders to their family', () => {
    expect(specSplitFamilyOf('shuffle-mage-fire')).toBe('shuffle');
    expect(specSplitFamilyOf('blitz-warrior-arms')).toBe('blitz');
  });

  it('returns null for ladders with a single rating per character', () => {
    for (const bracket of ['2v2', '3v3', 'rbg']) {
      expect(specSplitFamilyOf(bracket)).toBeNull();
    }
  });

  it('does not treat a family name on its own as a member', () => {
    // Guards the prefix check: "shuffle-overall" is excluded upstream, but a
    // bare "shuffle" must not be mistaken for a per-spec bracket either.
    expect(specSplitFamilyOf('shuffle')).toBeNull();
    expect(specSplitFamilyOf('blitzkrieg')).toBeNull();
  });
});
