import { describe, expect, it } from 'vitest';

import { raidRankingsSchema } from '../raiderio/schemas/raid-rankings.schema.js';
import { toGuildDocument, toRankedGuild } from './raid-rankings.mapper.js';

/** Trimmed from a real `/raiding/raid-rankings` answer (checked live, 2026-10-02). */
const ECHO = {
  rank: 1,
  regionRank: 1,
  guild: {
    id: 1047044,
    name: 'Echo',
    displayName: 'Echo',
    faction: 'horde',
    realm: { id: 719, name: 'Tarren Mill', altName: null, slug: 'tarren-mill', locale: 'en_GB' },
    region: { name: 'Europe', slug: 'eu', short_name: 'EU' },
    path: '/guilds/eu/tarren-mill/Echo',
    logo: 'https://u-wowretail.raiderio.net/12e5/image.png',
    color: '#f41313',
    isDefaultLogo: false,
  },
  encountersDefeated: [
    {
      slug: 'the-coiled-altar',
      firstDefeated: '2026-08-30T07:04:45.000Z',
      lastDefeated: '2026-10-01T17:26:21.000Z',
      attempts: 0,
    },
    {
      slug: 'ulatek',
      firstDefeated: '2026-09-03T19:29:00.000Z',
      lastDefeated: '2026-10-01T18:08:23.000Z',
    },
  ],
  guildPrivacy: { raidPulls: true, wereRaidPullsRestricted: false },
  encountersPulled: [
    {
      id: 700778,
      slug: 'the-coiled-altar',
      numPulls: 219,
      pullStartedAt: '2026-08-30T06:54:07Z',
      bestPercent: 0,
      isDefeated: true,
    },
    {
      id: 1070720,
      slug: 'ulatek',
      numPulls: 335,
      pullStartedAt: '2026-09-03T19:19:40Z',
      bestPercent: 0,
      isDefeated: true,
    },
  ],
};

/** A guild that restricts its pulls, still on its last boss. */
const RESTRICTED = {
  rank: 37,
  regionRank: 12,
  guild: { id: 5, name: 'Hidden', faction: 'alliance', region: { slug: 'us' } },
  encountersDefeated: [],
  encountersPulled: [
    {
      id: 1,
      slug: 'ulatek',
      bestPercent: 41.27,
      isDefeated: false,
      bossPercent: 41.27,
      phase: 2,
      phaseLabel: 'P2',
      progressDisplay: 'P2 41%',
    },
  ],
};

const ENCOUNTERS = [
  { id: 3301, slug: 'the-coiled-altar', name: 'The Coiled Altar' },
  { id: 3302, slug: 'ulatek', name: "Ula'tek" },
];

const parse = (...entries: unknown[]) =>
  raidRankingsSchema.parse({ raidRankings: entries }).raidRankings;

describe('raidRankingsSchema', () => {
  it('parses an entry with everything upstream sends, keeping only what is stored', () => {
    const [entry] = parse(ECHO);

    expect(entry.guild).toEqual({
      id: 1047044,
      name: 'Echo',
      faction: 'horde',
      logo: 'https://u-wowretail.raiderio.net/12e5/image.png',
      region: { slug: 'eu' },
      realm: { slug: 'tarren-mill', name: 'Tarren Mill' },
    });
    expect(entry.encountersPulled![0]).toEqual({
      slug: 'the-coiled-altar',
      numPulls: 219,
      pullStartedAt: '2026-08-30T06:54:07Z',
      bestPercent: 0,
      isDefeated: true,
    });
  });

  it('parses a guild with restricted pulls, and one with no progress lists at all', () => {
    const [restricted, bare] = parse(RESTRICTED, { rank: 3, guild: { id: 9, name: 'Bare' } });

    expect(restricted.encountersPulled![0].numPulls).toBeUndefined();
    expect(bare).toEqual({ rank: 3, guild: { id: 9, name: 'Bare' } });
  });

  it('parses an empty board, which is how a raid nobody is ranked on answers', () => {
    expect(parse()).toEqual([]);
  });

  it('refuses an entry with no guild id or no rank, and a body that is not a board', () => {
    expect(() => parse({ rank: 1, guild: { name: 'No id' } })).toThrow();
    expect(() => parse({ guild: { id: 1, name: 'No rank' } })).toThrow();
    expect(() => raidRankingsSchema.parse({ statusCode: 400 })).toThrow();
  });
});

describe('toGuildDocument', () => {
  const at = new Date('2026-10-02T12:00:00Z');

  it('describes the guild by its own region and realm', () => {
    expect(toGuildDocument(parse(ECHO)[0], at)).toEqual({
      id: 1047044,
      name: 'Echo',
      faction: 'horde',
      logo: 'https://u-wowretail.raiderio.net/12e5/image.png',
      region: 'eu',
      realm: { slug: 'tarren-mill', name: 'Tarren Mill' },
      updatedAt: at,
    });
  });

  it('stores what is absent as null rather than leaving the field out', () => {
    expect(toGuildDocument(parse({ rank: 3, guild: { id: 9, name: 'Bare' } })[0], at)).toEqual({
      id: 9,
      name: 'Bare',
      faction: null,
      logo: null,
      region: null,
      realm: null,
      updatedAt: at,
    });
  });
});

describe('toRankedGuild', () => {
  it('ties each boss to the raid encounter of the same slug, not to upstream id', () => {
    expect(toRankedGuild(parse(ECHO)[0], ENCOUNTERS)).toEqual({
      rank: 1,
      regionRank: 1,
      guildId: 1047044,
      encountersPulled: [
        {
          encounterId: 3301,
          slug: 'the-coiled-altar',
          numPulls: 219,
          pullStartedAt: new Date('2026-08-30T06:54:07Z'),
          bestPercent: 0,
          isDefeated: true,
        },
        {
          encounterId: 3302,
          slug: 'ulatek',
          numPulls: 335,
          pullStartedAt: new Date('2026-09-03T19:19:40Z'),
          bestPercent: 0,
          isDefeated: true,
        },
      ],
      encountersDefeated: [
        {
          encounterId: 3301,
          slug: 'the-coiled-altar',
          firstDefeated: new Date('2026-08-30T07:04:45Z'),
          lastDefeated: new Date('2026-10-01T17:26:21Z'),
        },
        {
          encounterId: 3302,
          slug: 'ulatek',
          firstDefeated: new Date('2026-09-03T19:29:00Z'),
          lastDefeated: new Date('2026-10-01T18:08:23Z'),
        },
      ],
    });
  });

  it('keeps a restricted guild: no pull count, the best attempt, not defeated', () => {
    expect(toRankedGuild(parse(RESTRICTED)[0], ENCOUNTERS)).toEqual({
      rank: 37,
      regionRank: 12,
      guildId: 5,
      encountersPulled: [
        {
          encounterId: 3302,
          slug: 'ulatek',
          numPulls: null,
          pullStartedAt: null,
          bestPercent: 41.27,
          isDefeated: false,
        },
      ],
      encountersDefeated: [],
    });
  });

  it('leaves a boss the raid does not list untied, and an entry with no lists empty', () => {
    const [entry] = parse({
      rank: 2,
      guild: { id: 7, name: 'Odd' },
      encountersPulled: [{ slug: 'not-in-the-raid', numPulls: 3, pullStartedAt: 'soon' }],
    });

    expect(toRankedGuild(entry, ENCOUNTERS)).toEqual({
      rank: 2,
      regionRank: null,
      guildId: 7,
      encountersPulled: [
        {
          encounterId: null,
          slug: 'not-in-the-raid',
          numPulls: 3,
          pullStartedAt: null,
          bestPercent: null,
          isDefeated: false,
        },
      ],
      encountersDefeated: [],
    });
    expect(toRankedGuild(parse({ rank: 3, guild: { id: 9, name: 'Bare' } })[0], [])).toEqual({
      rank: 3,
      regionRank: null,
      guildId: 9,
      encountersPulled: [],
      encountersDefeated: [],
    });
  });
});
