/**
 * The class/spec/hero-tree table the World is built from.
 *
 * Real shape, not a toy: the 40 specialisations the live API actually
 * publishes, verified against `pvp-leaderboard/index` rather than assumed —
 * Demon Hunter has a third spec, Devourer, which is easy to miss. That is what
 * makes the default world publish the same 85 brackets Blizzard does: 3 core,
 * 2 aggregates, and a shuffle and blitz ladder per spec. Anything that
 * hardcodes a bracket count fails here rather than in production.
 *
 * Slugs follow Blizzard's bracket naming, which strips spaces and lowercases:
 * "Beast Mastery" appears in `shuffle-hunter-beastmastery`.
 */
export interface SpecDefinition {
  classId: number;
  className: string;
  classSlug: string;
  specId: number;
  specName: string;
  specSlug: string;
  /** Both hero trees the spec can pick. Only one is active at a time. */
  heroTrees: { id: number; name: string }[];
}

const RAW: [string, string, [number, string][]][] = [
  [
    'Death Knight',
    'deathknight',
    [
      [1, 'Blood'],
      [2, 'Frost'],
      [3, 'Unholy'],
    ],
  ],
  [
    'Demon Hunter',
    'demonhunter',
    [
      [4, 'Havoc'],
      [5, 'Vengeance'],
      [40, 'Devourer'],
    ],
  ],
  [
    'Druid',
    'druid',
    [
      [6, 'Balance'],
      [7, 'Feral'],
      [8, 'Guardian'],
      [9, 'Restoration'],
    ],
  ],
  [
    'Evoker',
    'evoker',
    [
      [10, 'Devastation'],
      [11, 'Preservation'],
      [12, 'Augmentation'],
    ],
  ],
  [
    'Hunter',
    'hunter',
    [
      [13, 'Beast Mastery'],
      [14, 'Marksmanship'],
      [15, 'Survival'],
    ],
  ],
  [
    'Mage',
    'mage',
    [
      [16, 'Arcane'],
      [17, 'Fire'],
      [18, 'Frost'],
    ],
  ],
  [
    'Monk',
    'monk',
    [
      [19, 'Brewmaster'],
      [20, 'Mistweaver'],
      [21, 'Windwalker'],
    ],
  ],
  [
    'Paladin',
    'paladin',
    [
      [22, 'Holy'],
      [23, 'Protection'],
      [24, 'Retribution'],
    ],
  ],
  [
    'Priest',
    'priest',
    [
      [25, 'Discipline'],
      [26, 'Holy'],
      [27, 'Shadow'],
    ],
  ],
  [
    'Rogue',
    'rogue',
    [
      [28, 'Assassination'],
      [29, 'Outlaw'],
      [30, 'Subtlety'],
    ],
  ],
  [
    'Shaman',
    'shaman',
    [
      [31, 'Elemental'],
      [32, 'Enhancement'],
      [33, 'Restoration'],
    ],
  ],
  [
    'Warlock',
    'warlock',
    [
      [34, 'Affliction'],
      [35, 'Demonology'],
      [36, 'Destruction'],
    ],
  ],
  [
    'Warrior',
    'warrior',
    [
      [37, 'Arms'],
      [38, 'Fury'],
      [39, 'Protection'],
    ],
  ],
];

/**
 * Two hero trees per spec. The names matter for one case in particular: a Fury
 * warrior holds Mountain Thane, which Arms cannot — the pairing that exposed
 * hero talents being credited to the wrong ladder.
 */
const HERO_TREES: Record<string, string[]> = {
  'warrior/Arms': ['Colossus', 'Slayer'],
  'warrior/Fury': ['Mountain Thane', 'Slayer'],
  'warrior/Protection': ['Colossus', 'Mountain Thane'],
  'mage/Fire': ['Frostfire', 'Sunfury'],
  'mage/Frost': ['Frostfire', 'Spellslinger'],
  'mage/Arcane': ['Sunfury', 'Spellslinger'],
  'paladin/Holy': ['Herald of the Sun', 'Lightsmith'],
  'paladin/Retribution': ['Herald of the Sun', 'Templar'],
  'paladin/Protection': ['Lightsmith', 'Templar'],
};

export const SPECS: SpecDefinition[] = RAW.flatMap(([className, classSlug, specs], classIndex) =>
  specs.map(([specId, specName]) => {
    const key = `${classSlug}/${specName}`;
    const names = HERO_TREES[key] ?? [`${specName} Adept`, `${specName} Master`];

    return {
      classId: classIndex + 1,
      className,
      classSlug,
      specId,
      specName,
      specSlug: specName.toLowerCase().replaceAll(' ', ''),
      heroTrees: names.map((name, index) => ({ id: specId * 10 + index, name })),
    };
  }),
);

export const SPEC_BY_SLUG = new Map(
  SPECS.map((spec) => [`${spec.classSlug}-${spec.specSlug}`, spec]),
);
