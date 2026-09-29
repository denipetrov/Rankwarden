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
  /**
   * The season the run is served for. Absent means every season, which is what
   * the live-pass files rely on; archive files set it, so one archived season's
   * board does not leak into another's.
   */
  season?: string;
  /**
   * The run's affixes. Absent means Tyrannical and Fortified, which the
   * live-pass files rely on; set it for a season whose affixes rotated weekly,
   * so runs on one board carry different sets, as they do upstream.
   */
  affixes?: MplusWorldAffix[];
  roster: MplusWorldMember[];
}

export interface MplusWorldAffix {
  id: number;
  name: string;
  slug: string;
}

export interface MplusWorldMember {
  /** Raider.io's id. `0` marks an anonymised character, as the real API does. */
  id: number;
  name: string;
  realmSlug: string;
  /**
   * Blizzard's realm id. Absent for an anonymised realm, as upstream; `null` for
   * a realm Blizzard does not list as live, such as a tournament realm (§9.14).
   */
  wowRealmId?: number | null;
  classId: number;
  specId: number | null;
  role: string;
  anonymised?: boolean;
  /**
   * Serve Legion's spec placeholder, `{"name": "", "slug": ""}` with no id,
   * instead of a spec — what Raider.io sends for a run whose specs were never
   * recorded (§9.14). Overrides `specId`.
   */
  specPlaceholder?: boolean;
  /**
   * The region the character itself belongs to, served as
   * `character.region.slug`. Absent means the board's region, which is what
   * upstream is assumed to do and what I24 checks the fold relies on.
   */
  region?: string;
}

export interface MplusWorldSeason {
  slug: string;
  name: string;
  blizzardSeasonId: number | null;
  isMainSeason: boolean;
  /** ISO start per region; absent regions are treated as already open. */
  starts: Record<string, string>;
  /** ISO end per region. A running season carries Raider.io's 2030 placeholder. */
  ends?: Record<string, string>;
  /** Which `static-data?expansion_id` lists it. Midnight (11) when absent. */
  expansionId?: number;
  dungeons: number;
  /** First dungeon id this season lists, so seasons can share dungeons or not. */
  firstDungeonId?: number;
}

/** The three dungeons `seed` cycles through, for runs built by hand. */
export const WORLD_DUNGEONS = [
  { id: 9527, name: 'Temple of Sethraliss', slug: 'temple-of-sethraliss' },
  { id: 9526, name: "Kings' Rest", slug: 'kings-rest' },
  { id: 16368, name: 'Den of Nalorakk', slug: 'den-of-nalorakk' },
] as const;

/**
 * A named member on an ordinary realm, for runs built by hand. The same `id`
 * and `name` always make the same character, which is what lets one appear in
 * several runs.
 */
export function member(
  id: number,
  name: string,
  overrides: Partial<MplusWorldMember> = {},
): MplusWorldMember {
  return {
    id,
    name,
    realmSlug: 'stormrage',
    wowRealmId: 60,
    classId: 5,
    specId: 258,
    role: 'dps',
    ...overrides,
  };
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
      ends: { us: '2030-01-01T00:00:00Z', eu: '2030-01-01T00:00:00Z' },
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
      ends: { us: '2026-08-18T15:00:00Z', eu: '2026-08-19T04:00:00Z' },
      starts: { us: '2026-03-24T15:00:00Z' },
      dungeons: 8,
    },
    {
      // The side event that must never be picked as the current season.
      slug: 'season-mn-1-break-the-meta',
      name: 'Break the Meta',
      blizzardSeasonId: 17,
      isMainSeason: false,
      ends: { us: '2026-07-21T15:00:00Z' },
      starts: { us: '2026-07-14T15:00:00Z' },
      dungeons: 8,
    },
  ];

  runs: MplusWorldRun[] = [];

  /** Regions the fake will serve at all; anything else 404s. */
  regions = ['us', 'eu', 'kr', 'tw', 'cn'];

  /** Seasons Raider.io answers 404 for, for the unarchivable path. */
  readonly unservedSeasons = new Set<string>();

  /**
   * Seasons `season-cutoffs` answers 404 for. Real: nothing before
   * `season-sl-3` has cutoffs at all.
   */
  readonly seasonsWithoutCutoffs = new Set<string>();

  /** The p999 score a season's cutoffs start from; each region adds its own offset. */
  cutoffBase: Record<string, number> = {};

  private nextRunId = 500_000;

  /**
   * Keep each board's ranking between requests rather than sorting every run
   * again for every page. Opt-in, for boards of thousands of runs, where a full
   * pass would otherwise sort the whole board a thousand times; call
   * `invalidate()` after changing `runs`, since nothing here can see an edit.
   */
  cacheRankings = false;
  private readonly rankings = new Map<string, MplusWorldRun[]>();

  /** Forgets cached rankings. Needed only with `cacheRankings` on. */
  invalidate(): void {
    this.rankings.clear();
  }

  /**
   * Adds one run built by hand: any roster, any score, one of `WORLD_DUNGEONS`.
   * For the cases `seed` cannot say — a tie, a roster of four, a character in
   * exactly the dungeons a case needs.
   */
  addRun(run: {
    region: string;
    score: number;
    members: MplusWorldMember[];
    dungeon?: number;
    season?: string;
    mythicLevel?: number;
    keystoneRunId?: number;
  }): MplusWorldRun {
    const dungeon = WORLD_DUNGEONS[run.dungeon ?? 0];
    const added: MplusWorldRun = {
      keystoneRunId: run.keystoneRunId ?? (this.nextRunId += 1),
      dungeonId: dungeon.id,
      dungeonName: dungeon.name,
      dungeonSlug: dungeon.slug,
      score: run.score,
      mythicLevel: run.mythicLevel ?? 20,
      region: run.region,
      ...(run.season ? { season: run.season } : {}),
      roster: run.members,
    };
    this.runs.push(added);

    return added;
  }

  /** Takes runs off the board, as runs falling out of the top do. */
  removeRuns(predicate: (run: MplusWorldRun) => boolean): MplusWorldRun[] {
    const removed = this.runs.filter(predicate);
    this.runs = this.runs.filter((run) => !predicate(run));

    return removed;
  }

  /**
   * Adds `count` runs to a region, scored descending from `topScore`, served for
   * `season` only when one is given.
   */
  seed(region: string, count: number, topScore = 500, season?: string): this {
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
        ...(season ? { season } : {}),
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

  /**
   * The `/mythic-plus/static-data` payload for one expansion.
   *
   * Per expansion, as the real endpoint is: `expansion_id=6` lists Legion and
   * nothing else. An expansion with no seasons answers with an empty list, which
   * is how the catalogue walk knows where to stop.
   */
  staticData(expansionId = 11): unknown {
    return {
      seasons: this.seasons
        .filter((season) => (season.expansionId ?? 11) === expansionId)
        .map((season) => ({
          slug: season.slug,
          name: season.name,
          short_name: season.slug.toUpperCase(),
          blizzard_season_id: season.blizzardSeasonId,
          is_main_season: season.isMainSeason,
          seasonal_affix: null,
          starts: season.starts,
          ends: season.ends ?? {},
          dungeons: Array.from({ length: season.dungeons }, (_unused, index) => {
            // A season with no `firstDungeonId` lists the dungeons `seed` and
            // `addRun` play runs in, then 9503 onward — as upstream, where a
            // season lists every dungeon its runs are in. An explicit
            // `firstDungeonId` numbers the whole list from there instead.
            const played = season.firstDungeonId === undefined ? WORLD_DUNGEONS[index] : undefined;

            return {
              id: played?.id ?? (season.firstDungeonId ?? 9_500) + index,
              challenge_mode_id: 200 + index,
              slug: played?.slug ?? `dungeon-${index}`,
              name: played?.name ?? `Dungeon ${index}`,
              short_name: `D${index}`,
              keystone_timer_seconds: 1_800,
            };
          }),
        })),
      dungeons: [],
    };
  }

  /**
   * The `/mythic-plus/season-cutoffs` payload for one season and region.
   *
   * Reproduces the two shapes that matter. A tier the season did not award is
   * `null` — `keystoneMyth` is, for every season before Midnight — and the
   * payload carries far more than is stored, so the extra keys are here to be
   * ignored.
   */
  cutoffs(season: string, region: string): unknown {
    const base = (this.cutoffBase[season] ?? 3_000) + this.regions.indexOf(region) * 10;
    const band = (score: number, quantile: number, count: number) => ({
      quantile,
      quantileMinValue: score,
      quantilePopulationCount: count,
      quantilePopulationFraction: quantile,
      totalPopulationCount: 100_000,
    });
    const entry = (score: number, quantile: number, tierScore?: number) => ({
      ...(tierScore === undefined ? {} : { score: tierScore }),
      horde: band(score - 20, quantile, 500),
      hordeColor: '#e85e7d',
      alliance: band(score + 20, quantile, 520),
      allianceColor: '#f87342',
      all: band(score, quantile, 1_020),
      allColor: '#f77149',
    });

    return {
      cutoffs: {
        updatedAt: 'Mon Jan 19 2026 22:41:01 GMT+0000 (Coordinated Universal Time)',
        region: { name: region.toUpperCase(), slug: region, short_name: region.toUpperCase() },
        p999: entry(base, 0.999),
        p990: entry(base - 300, 0.99),
        // Stored figures stop here; the rest is payload the mapper drops.
        p900: entry(base - 600, 0.9),
        p750: entry(base - 900, 0.75),
        graphData: [{ x: 1, y: 2 }],
        // Midnight's tier: null for every earlier season, as upstream.
        keystoneMyth: null,
        keystoneLegend: null,
        keystoneHero: entry(2_500, 0.658, 2_500),
        keystoneMaster: entry(2_000, 0.515, 2_000),
        keystoneConqueror: entry(1_500, 0.32, 1_500),
        keystoneExplorer: entry(750, 0.12, 750),
        bracketDungeonLevels: {},
        isRemappedSeason: true,
        allTimed20: 5,
      },
    };
  }

  /** One page of `/mythic-plus/runs`, in the API's own shape. */
  runsPage(season: string, region: string, page: number): unknown {
    const board = `${season}|${region}`;
    const ranked =
      (this.cacheRankings ? this.rankings.get(board) : undefined) ??
      this.runs
        .filter((run) => run.region === region)
        .filter((run) => run.season === undefined || run.season === season)
        .sort((left, right) => right.score - left.score);
    if (this.cacheRankings) this.rankings.set(board, ranked);
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
          weekly_modifiers: run.affixes?.map((affix) => ({
            id: affix.id,
            icon: `icon-${affix.slug}`,
            name: affix.name,
            slug: affix.slug,
            description: `${affix.name}, as described upstream.`,
          })) ?? [
            {
              id: 9,
              icon: 'achievement_boss_archaedas',
              name: 'Tyrannical',
              slug: 'tyrannical',
              description: 'Bosses have 25% more health.',
            },
            { id: 10, icon: 'ability_toughness', name: 'Fortified', slug: 'fortified' },
          ],
          num_modifiers_active: run.affixes?.length ?? 2,
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
              spec: member.specPlaceholder
                ? { name: '', slug: '' }
                : member.specId === null
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
                : `/characters/${member.region ?? run.region}/${member.realmSlug}/${member.name}`,
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
                name: (member.region ?? run.region).toUpperCase(),
                slug: member.region ?? run.region,
                short_name: (member.region ?? run.region).toUpperCase(),
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
