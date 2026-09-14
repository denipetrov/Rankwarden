import { describe, expect, it } from 'vitest';

import { mythicPlusRunsSchema } from './mythic-plus-runs.schema.js';

/**
 * Verbatim from a live `/mythic-plus/runs` response on 2026-09-14, trimmed to
 * two roster entries. The point of keeping it verbatim is that every optional
 * marker in the schema was put there because of something in this payload, and
 * a copy that has been tidied up stops testing that.
 */
const page = {
  rankings: [
    {
      rank: 1,
      score: 515.3,
      run: {
        keystone_team_id: 437635648,
        season: 'season-mn-2',
        status: 'finished',
        dungeon: {
          type: 'dungeon',
          id: 9527,
          name: 'Temple of Sethraliss',
          short_name: 'TOS',
          slug: 'temple-of-sethraliss',
          expansion_id: 7,
          icon_url: '/images/wow/icons/large/achievement_dungeon_templeofsethraliss.jpg',
          patch: '8.0',
          wowInstanceId: 1877,
          map_challenge_mode_id: 250,
          keystone_timer_ms: 1920999,
          num_bosses: 4,
          group_finder_activity_ids: [503, 504, 505, 542, 645],
        },
        keystone_run_id: 11626563,
        mythic_level: 22,
        clear_time_ms: 1906389,
        keystone_time_ms: 1920999,
        completed_at: '2026-09-13T08:00:10.000Z',
        num_chests: 1,
        time_remaining_ms: 14610,
        logged_run_id: 3457402,
        videos: [],
        weekly_modifiers: [
          {
            id: 9,
            icon: 'achievement_boss_archaedas',
            name: 'Tyrannical',
            slug: 'tyrannical',
            description: 'Bosses have 25% more health.',
          },
        ],
        num_modifiers_active: 3,
        faction: 'alliance',
        deleted_at: null,
        keystone_platoon_id: null,
        platoon: null,
        roster: [
          {
            character: {
              id: 308600357,
              persona_id: 0,
              name: '风为',
              class: { id: 8, name: 'Mage', slug: 'mage' },
              race: { id: 3, name: 'Dwarf', slug: 'dwarf', faction: 'alliance' },
              faction: 'alliance',
              level: 90,
              spec: { id: 62, name: 'Arcane', slug: 'arcane' },
              path: '/characters/cn/silvermoon/风为',
              realm: {
                id: 2310,
                connectedRealmId: 538,
                wowRealmId: 889,
                wowConnectedRealmId: 889,
                name: 'Silvermoon',
                altName: '银月',
                slug: 'silvermoon',
                altSlug: '银月',
                locale: 'zh_CN',
                isConnected: false,
                realmType: 'live',
              },
              region: { name: 'China', slug: 'cn', short_name: 'CN' },
              stream: null,
              recruitmentProfiles: [],
              flags: {},
            },
            oldCharacter: null,
            isTransfer: false,
            isBanned: false,
            role: 'dps',
            loadout:
              'C4DAAAAAAAAAAAAAAAAAAAAAAYGmZZmxsgZQzMzAAAwAAmZmmlllZAgYDAgNGzMDbWmxMLzYMjZmhFmZmZmBAYAAAGgZGYmBADzMD',
          },
          {
            // The anonymised shape, verbatim. Note what is MISSING from the
            // realm: wowRealmId, wowConnectedRealmId, altName, realmType. A
            // schema requiring any of them fails the whole page, and roughly
            // one roster entry in two hundred looks like this.
            character: {
              id: 0,
              persona_id: 0,
              name: 'Anon12627389',
              class: { id: 2, name: 'Paladin', slug: 'paladin' },
              race: { id: 3, name: 'Dwarf', slug: 'dwarf', faction: 'alliance' },
              faction: 'alliance',
              level: 90,
              spec: { id: 65, name: 'Holy', slug: 'holy' },
              path: '',
              realm: {
                id: 0,
                connectedRealmId: 0,
                name: 'Anonymous',
                slug: 'anonymous',
                altSlug: 'anonymous',
                locale: '',
                isConnected: false,
                anonymized: true,
              },
              region: { name: 'Europe', slug: 'eu', short_name: 'EU' },
              anonymized: true,
              recruitmentProfiles: [],
              flags: {},
            },
            oldCharacter: null,
            isTransfer: false,
            isBanned: false,
            role: 'healer',
            // Null happens: a run logged without an importable talent string.
            loadout: null,
          },
        ],
      },
    },
  ],
  leaderboard_url:
    'https://raider.io/mythic-plus-rankings/season-mn-2/all/world/leaderboards-strict',
  params: {
    access_key: 'redacted',
    dungeon: 'all',
    page: 0,
    region: 'world',
    season: 'season-mn-2',
  },
};

describe('mythicPlusRunsSchema', () => {
  it('parses a live page including its anonymised entry', () => {
    const parsed = mythicPlusRunsSchema.parse(page);

    expect(parsed.rankings).toHaveLength(1);
    expect(parsed.rankings[0].run.roster).toHaveLength(2);
  });

  it('accepts a realm with no wowRealmId', () => {
    const parsed = mythicPlusRunsSchema.parse(page);
    const [ordinary, anonymous] = parsed.rankings[0].run.roster;

    expect(ordinary.character.realm.wowRealmId).toBe(889);
    expect(anonymous.character.realm.wowRealmId).toBeUndefined();
    expect(anonymous.character.realm.anonymized).toBe(true);
  });

  it('accepts a null loadout', () => {
    const parsed = mythicPlusRunsSchema.parse(page);

    expect(parsed.rankings[0].run.roster[1].loadout).toBeNull();
  });

  it('accepts an empty page, which is how a shallow region ends', () => {
    expect(mythicPlusRunsSchema.parse({ rankings: [] }).rankings).toEqual([]);
  });

  it('rejects a payload with no rankings array at all', () => {
    // A too-strict schema fails the whole parse, which is the right trade; but
    // the failure has to be real drift, not an absent optional.
    expect(() => mythicPlusRunsSchema.parse({ leaderboard_url: 'x' })).toThrow();
  });
});
