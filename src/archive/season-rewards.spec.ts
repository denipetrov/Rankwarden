import { describe, expect, it } from 'vitest';

import type { PvpReward } from '../blizzard/schemas/pvp-reward.schema.js';
import { bracketSlug, mapSeasonRewards, specIdsIn, specLadderSuffix } from './season-rewards.js';

/**
 * Shapes taken from a live `pvp-reward/index` for season 41 (us), trimmed to
 * the fields the schema keeps. Real spec ids, because the ambiguous names are
 * the point: Holy is 65 on a paladin and 257 on a priest.
 */
const ALLIANCE = { type: 'ALLIANCE', name: 'Alliance' };
const HORDE = { type: 'HORDE', name: 'Horde' };

const shuffle = (specId: number, specName: string, cutoff: number): PvpReward => ({
  bracket: { id: 6, type: 'SHUFFLE' },
  achievement: { id: 61179, name: 'Galactic Legend: Midnight Season 1' },
  rating_cutoff: cutoff,
  specialization: { id: specId, name: specName },
});

const blitz = (specId: number, specName: string, faction: typeof ALLIANCE, cutoff: number) => ({
  bracket: { id: 8, type: 'BLITZ' },
  achievement:
    faction === ALLIANCE
      ? { id: 61177, name: 'Galactic Marshal: Midnight Season 1' }
      : { id: 61178, name: 'Galactic Warlord: Midnight Season 1' },
  rating_cutoff: cutoff,
  faction,
  specialization: { id: specId, name: specName },
});

const gladiator: PvpReward = {
  bracket: { id: 1, type: 'ARENA_3v3' },
  achievement: { id: 61180, name: 'Galactic Gladiator: Midnight Season 1' },
  rating_cutoff: 3134,
};

const hero = (faction: typeof ALLIANCE): PvpReward => ({
  bracket: { id: 3, type: 'BATTLEGROUNDS' },
  achievement:
    faction === ALLIANCE
      ? { id: 61195, name: 'Hero of the Alliance: Galactic' }
      : { id: 61196, name: 'Hero of the Horde: Galactic' },
  rating_cutoff: 2684,
  faction,
});

const SPEC_LADDERS = new Map([
  [72, 'warrior-fury'],
  [581, 'demonhunter-vengeance'],
  [65, 'paladin-holy'],
  [257, 'priest-holy'],
  [254, 'hunter-marksmanship'],
]);

const PUBLISHED = new Set([
  '2v2',
  '3v3',
  'rbg',
  'shuffle-warrior-fury',
  'shuffle-demonhunter-vengeance',
  'shuffle-paladin-holy',
  'shuffle-priest-holy',
  'blitz-hunter-marksmanship',
]);

describe('bracketSlug', () => {
  it("spells names the way Blizzard's bracket names do", () => {
    // Checked against every one of the 40 live specs: lowercased, spaces gone.
    expect(bracketSlug('Beast Mastery')).toBe('beastmastery');
    expect(specLadderSuffix('Death Knight', 'Unholy')).toBe('deathknight-unholy');
    expect(specLadderSuffix('Demon Hunter', 'Devourer')).toBe('demonhunter-devourer');
  });
});

describe('specIdsIn', () => {
  it('lists each spec a set of rewards names, once', () => {
    const rewards = [
      shuffle(72, 'Fury', 3184),
      blitz(254, 'Marksmanship', ALLIANCE, 3427),
      blitz(254, 'Marksmanship', HORDE, 3427),
      gladiator,
    ];

    expect(specIdsIn(rewards).sort((a, b) => a - b)).toEqual([72, 254]);
  });
});

describe('mapSeasonRewards', () => {
  it('attaches each per-spec reward to its own ladder, by id rather than by name', () => {
    // "Holy" alone names two ladders. The id is what settles which.
    const { rewards } = mapSeasonRewards(
      [shuffle(65, 'Holy', 2400), shuffle(257, 'Holy', 2600)],
      SPEC_LADDERS,
      PUBLISHED,
    );

    expect(rewards.map((reward) => [reward.bracket, reward.ratingCutoff])).toEqual([
      ['shuffle-paladin-holy', 2400],
      ['shuffle-priest-holy', 2600],
    ]);
  });

  it('records the cutoff and the title exactly as Blizzard names them', () => {
    const { rewards } = mapSeasonRewards([shuffle(72, 'Fury', 3184)], SPEC_LADDERS, PUBLISHED);

    expect(rewards).toEqual([
      {
        bracket: 'shuffle-warrior-fury',
        faction: null,
        ratingCutoff: 3184,
        title: 'Galactic Legend: Midnight Season 1',
        achievementId: 61179,
        specialization: { id: 72, name: 'Fury' },
      },
    ]);
  });

  it('keeps one entry per faction where the title differs by side', () => {
    const { rewards } = mapSeasonRewards(
      [
        blitz(254, 'Marksmanship', HORDE, 3427),
        blitz(254, 'Marksmanship', ALLIANCE, 3427),
        hero(HORDE),
        hero(ALLIANCE),
      ],
      SPEC_LADDERS,
      PUBLISHED,
    );

    expect(rewards.map((reward) => [reward.bracket, reward.faction, reward.title])).toEqual([
      ['blitz-hunter-marksmanship', 'ALLIANCE', 'Galactic Marshal: Midnight Season 1'],
      ['blitz-hunter-marksmanship', 'HORDE', 'Galactic Warlord: Midnight Season 1'],
      ['rbg', 'ALLIANCE', 'Hero of the Alliance: Galactic'],
      ['rbg', 'HORDE', 'Hero of the Horde: Galactic'],
    ]);
  });

  it('keeps faction cutoffs apart when they differ, as Shadowlands 3v3 did', () => {
    const { rewards } = mapSeasonRewards(
      [
        { ...gladiator, rating_cutoff: 2928, faction: HORDE },
        { ...gladiator, rating_cutoff: 3006, faction: ALLIANCE },
      ],
      SPEC_LADDERS,
      PUBLISHED,
    );

    expect(rewards.map((reward) => [reward.faction, reward.ratingCutoff])).toEqual([
      ['ALLIANCE', 3006],
      ['HORDE', 2928],
    ]);
  });

  it('reports a reward it cannot place instead of guessing', () => {
    const { rewards, unmatched } = mapSeasonRewards(
      [
        gladiator,
        // A bracket type nothing maps, and a spec whose class is not known.
        { ...gladiator, bracket: { id: 9, type: 'ARENA_5v5' } },
        shuffle(9999, 'Mystery', 2000),
      ],
      SPEC_LADDERS,
      PUBLISHED,
    );

    expect(rewards.map((reward) => reward.bracket)).toEqual(['3v3']);
    expect(unmatched).toEqual([
      'ARENA_5v5 (no ladder for it)',
      'SHUFFLE spec 9999 (Mystery) (no ladder for it)',
    ]);
  });

  it('drops a reward whose ladder the season does not publish', () => {
    // More likely a mapping that has drifted than a ladder that exists unlisted.
    const { rewards, unmatched } = mapSeasonRewards(
      [shuffle(72, 'Fury', 3184)],
      SPEC_LADDERS,
      new Set(['3v3']),
    );

    expect(rewards).toEqual([]);
    expect(unmatched).toEqual([
      'SHUFFLE spec 72 (Fury) (shuffle-warrior-fury is not published this season)',
    ]);
  });

  it('filters on nothing when the bracket list could not be read', () => {
    const { rewards } = mapSeasonRewards([shuffle(72, 'Fury', 3184)], SPEC_LADDERS, new Set());

    expect(rewards.map((reward) => reward.bracket)).toEqual(['shuffle-warrior-fury']);
  });

  it('orders the result the same way whatever order Blizzard sends', () => {
    const input = [hero(HORDE), shuffle(72, 'Fury', 3184), gladiator, hero(ALLIANCE)];

    const forwards = mapSeasonRewards(input, SPEC_LADDERS, PUBLISHED).rewards;
    const backwards = mapSeasonRewards([...input].reverse(), SPEC_LADDERS, PUBLISHED).rewards;

    expect(backwards).toEqual(forwards);
  });
});
