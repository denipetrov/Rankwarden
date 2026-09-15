import { MAX_RUNS_PAGE, RUNS_PER_PAGE } from '../../src/raiderio/raiderio.constants.js';

export interface MplusWorldRun {
  keystoneRunId: number;
  dungeonId: number;
  dungeonName: string;
  dungeonSlug: string;
  score: number;
  mythicLevel: number;
  /** Region the run belongs to, which is the region it is served for. */
  region: string;
  roster: MplusWorldMember[];
}

export interface MplusWorldMember {
  /** Raider.io's id. `0` marks an anonymised character, as the real API does. */
  id: number;
  name: string;
  realmSlug: string;
  /** Blizzard's realm id. Absent for an anonymised realm, as upstream. */
  wowRealmId?: number;
  classId: number;
  specId: number | null;
  role: string;
  anonymised?: boolean;
}

export interface MplusWorldSeason {
  slug: string;
  name: string;
  blizzardSeasonId: number | null;
  isMainSeason: boolean;
  /** ISO start per region; absent regions are treated as already open. */
  starts: Record<string, string>;
  dungeons: number;
}

/**
 * A mutable model of Raider.io's Mythic+ data, the counterpart to `World`.
 *
 * Scenarios are mutations to this between passes: a run added, a run removed
 * from the board, a season rolled over. It serves whole payloads rather than
 * parsed objects so the real zod schemas do the parsing, which is where the
 * payload traps live.
 */
export class MplusWorld {
  seasons: MplusWorldSeason[] = [
    {
      slug: 'season-mn-2',
      name: 'MN Season 2',
      blizzardSeasonId: 18,
      isMainSeason: true,
      starts: {
        us: '2026-08-18T15:00:00Z',
        eu: '2026-08-19T04:00:00Z',
        kr: '2026-08-19T23:00:00Z',
        tw: '2026-08-19T23:00:00Z',
        cn: '2026-08-19T23:00:00Z',
      },
      dungeons: 8,
    },
    {
      slug: 'season-mn-1',
      name: 'MN Season 1',
      blizzardSeasonId: 17,
      isMainSeason: true,
      starts: { us: '2026-03-24T15:00:00Z' },
      dungeons: 8,
    },
    {
      // The side event that must never be picked as the current season.
      slug: 'season-mn-1-break-the-meta',
      name: 'Break the Meta',
      blizzardSeasonId: 17,
      isMainSeason: false,
      starts: { us: '2026-07-14T15:00:00Z' },
      dungeons: 8,
    },
  ];

  runs: MplusWorldRun[] = [];

  /** Regions the fake will serve at all; anything else 404s. */
  regions = ['us', 'eu', 'kr', 'tw', 'cn'];

  /** Adds `count` runs to a region, scored descending from `topScore`. */
  seed(region: string, count: number, topScore = 500): this {
    const dungeons = [
      [9527, 'Temple of Sethraliss', 'temple-of-sethraliss'],
      [9526, "Kings' Rest", 'kings-rest'],
      [16368, 'Den of Nalorakk', 'den-of-nalorakk'],
    ] as const;

    for (let index = 0; index < count; index += 1) {
      const [dungeonId, dungeonName, dungeonSlug] = dungeons[index % dungeons.length];
      const base = this.runs.length + 1;

      this.runs.push({
        keystoneRunId: 100_000 + base,
        dungeonId,
        dungeonName,
        dungeonSlug,
        score: topScore - index,
        mythicLevel: 22,
        region,
        roster: [
          {
            id: 1_000 + index,
            name: `Tank${index}`,
            realmSlug: 'stormrage',
            wowRealmId: 60,
            classId: 6,
            specId: 250,
            role: 'tank',
          },
          {
            id: 2_000 + index,
            name: `Healer${index}`,
            realmSlug: 'area-52',
            wowRealmId: 1566,
            classId: 2,
            specId: 65,
            role: 'healer',
          },
          // Deliberately shared across every run in the region, so the fold's
          // best-per-dungeon behaviour has something to actually fold.
          {
            id: 3_001,
            name: 'Regular',
            realmSlug: 'illidan',
            wowRealmId: 57,
            classId: 8,
            specId: 62,
            role: 'dps',
          },
          {
            id: 3_002,
            name: 'Alsoregular',
            realmSlug: 'zuljin',
            wowRealmId: 61,
            classId: 1,
            specId: 71,
            role: 'dps',
          },
          // One anonymised member per run, at roughly the real rate of one in
          // two hundred roster entries once a board is a few hundred runs deep.
          ...(index % 40 === 0
            ? [
                {
                  id: 0,
                  name: `Anon${index}`,
                  realmSlug: 'anonymous',
                  classId: 5,
                  specId: 258,
                  role: 'dps',
                  anonymised: true,
                },
              ]
            : [
                {
                  id: 4_000 + index,
                  name: `Dps${index}`,
                  realmSlug: 'stormrage',
                  wowRealmId: 60,
                  classId: 5,
                  specId: 258,
                  role: 'dps',
                },
              ]),
        ],
      });
    }

    return this;
  }

  /** The `/mythic-plus/static-data` payload. */
  staticData(): unknown {
    return {
      seasons: this.seasons.map((season) => ({
        slug: season.slug,
        name: season.name,
        short_name: season.slug.toUpperCase(),
        blizzard_season_id: season.blizzardSeasonId,
        is_main_season: season.isMainSeason,
        seasonal_affix: null,
        starts: season.starts,
        ends: {},
        dungeons: Array.from({ length: season.dungeons }, (_unused, index) => ({
          id: 9_500 + index,
          challenge_mode_id: 200 + index,
          slug: `dungeon-${index}`,
          name: `Dungeon ${index}`,
          short_name: `D${index}`,
          keystone_timer_seconds: 1_800,
        })),
      })),
      dungeons: [],
    };
  }

  /** One page of `/mythic-plus/runs`, in the API's own shape. */
  runsPage(season: string, region: string, page: number): unknown {
    const ranked = this.runs
      .filter((run) => run.region === region)
      .sort((left, right) => right.score - left.score);
    const start = page * RUNS_PER_PAGE;

    return {
      rankings: ranked.slice(start, start + RUNS_PER_PAGE).map((run, offset) => ({
        rank: start + offset + 1,
        score: run.score,
        run: {
          keystone_team_id: run.keystoneRunId,
          season,
          status: 'finished',
          dungeon: {
            type: 'dungeon',
            id: run.dungeonId,
            name: run.dungeonName,
            slug: run.dungeonSlug,
            short_name: run.dungeonSlug.slice(0, 3).toUpperCase(),
            keystone_timer_ms: 1_920_999,
            num_bosses: 4,
            map_challenge_mode_id: 250,
          },
          keystone_run_id: run.keystoneRunId,
          mythic_level: run.mythicLevel,
          clear_time_ms: 1_906_389,
          keystone_time_ms: 1_920_999,
          completed_at: '2026-09-13T08:00:10.000Z',
          num_chests: 1,
          time_remaining_ms: 14_610,
          weekly_modifiers: [
            {
              id: 9,
              icon: 'achievement_boss_archaedas',
              name: 'Tyrannical',
              slug: 'tyrannical',
              description: 'Bosses have 25% more health.',
            },
            { id: 10, icon: 'ability_toughness', name: 'Fortified', slug: 'fortified' },
          ],
          num_modifiers_active: 2,
          faction: 'alliance',
          deleted_at: null,
          platoon: null,
          roster: run.roster.map((member) => ({
            character: {
              id: member.id,
              persona_id: 0,
              name: member.name,
              class: {
                id: member.classId,
                name: `Class${member.classId}`,
                slug: `class-${member.classId}`,
              },
              race: { id: 3, name: 'Dwarf', slug: 'dwarf', faction: 'alliance' },
              spec:
                member.specId === null
                  ? null
                  : {
                      id: member.specId,
                      name: `Spec${member.specId}`,
                      slug: `spec-${member.specId}`,
                    },
              faction: 'alliance',
              level: 90,
              path: member.anonymised
                ? ''
                : `/characters/${run.region}/${member.realmSlug}/${member.name}`,
              // The anonymised realm really does omit wowRealmId, altName,
              // locale and realmType. Reproduced deliberately: a schema that
              // required any of them would fail every page carrying one.
              realm: member.anonymised
                ? {
                    id: 0,
                    connectedRealmId: 0,
                    name: 'Anonymous',
                    slug: 'anonymous',
                    altSlug: 'anonymous',
                    locale: '',
                    isConnected: false,
                    anonymized: true,
                  }
                : {
                    id: 2_000 + (member.wowRealmId ?? 0),
                    connectedRealmId: 500,
                    wowRealmId: member.wowRealmId,
                    wowConnectedRealmId: member.wowRealmId,
                    name: member.realmSlug,
                    altName: null,
                    slug: member.realmSlug,
                    altSlug: member.realmSlug,
                    locale: 'en_US',
                    isConnected: true,
                    realmType: 'live',
                  },
              region: {
                name: run.region.toUpperCase(),
                slug: run.region,
                short_name: run.region.toUpperCase(),
              },
              stream: null,
              recruitmentProfiles: [],
              flags: {},
              ...(member.anonymised ? { anonymized: true } : {}),
            },
            oldCharacter: null,
            isTransfer: false,
            isBanned: false,
            role: member.role,
            // Null happens upstream on a run logged without a talent string.
            loadout: member.role === 'tank' ? null : 'CODE',
          })),
        },
      })),
      leaderboard_url: `https://raider.io/mythic-plus-rankings/${season}/all/${region}`,
      params: { dungeon: 'all', page, region, season },
    };
  }
}

export { MAX_RUNS_PAGE, RUNS_PER_PAGE };
