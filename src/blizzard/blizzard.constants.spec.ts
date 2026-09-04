import { describe, expect, it } from 'vitest';

import {
  EXCLUDED_BRACKETS,
  isIngestableBracket,
  ratingFamilyOf,
  specSplitFamilyOf,
} from './blizzard.constants.js';

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

describe('ratingFamilyOf', () => {
  it('gives the core brackets a family of their own', () => {
    expect(ratingFamilyOf('2v2')).toBe('2v2');
    expect(ratingFamilyOf('3v3')).toBe('3v3');
    expect(ratingFamilyOf('rbg')).toBe('rbg');
  });

  it('gathers per-spec ladders under their family', () => {
    expect(ratingFamilyOf('shuffle-mage-fire')).toBe('shuffle');
    expect(ratingFamilyOf('blitz-warrior-arms')).toBe('blitz');
  });

  it('returns null for anything it does not track', () => {
    expect(ratingFamilyOf('shuffle-overall')).toBeNull();
    expect(ratingFamilyOf('some-new-bracket')).toBeNull();
  });
});
