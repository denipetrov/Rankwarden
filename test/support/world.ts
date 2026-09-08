import { SPECS, SPEC_BY_SLUG, type SpecDefinition } from './specs.js';

export type WorldRegion = 'us' | 'eu' | 'kr' | 'tw';

/** Names chosen to exercise percent-encoding, not for flavour. */
const NAME_POOL: Record<WorldRegion, string[]> = {
  us: ['Warden', 'Zëph', 'Goküü', "Kel'thas", 'Mörgan', 'Ashvane'],
  eu: ['Zëph', 'Ölaf', "D'artagnan", 'Süleyman', 'Björn', 'Æther'],
  kr: ['김전사', '흑기사', '바람돌이', '용사', '그림자'],
  tw: ['戰士', '暗影', '烈焰', '冰霜', '聖光'],
};

const REALMS: Record<WorldRegion, [number, string][]> = {
  us: [
    [60, 'tarren-mill'],
    [61, 'emerald-dream'],
  ],
  eu: [
    [1301, 'outland'],
    [1305, 'draenor'],
  ],
  kr: [[205, 'azshara']],
  tw: [[963, 'shadowmoon']],
};

export interface WorldPlayer {
  id: number;
  region: WorldRegion;
  name: string;
  realmId: number;
  realmSlug: string;
  faction: 'HORDE' | 'ALLIANCE';
  spec: SpecDefinition;
  /** Index into `spec.heroTrees` for the currently active tree. */
  heroTreeIndex: number;
  /** Every spec this character has a saved loadout for, active spec included. */
  loadoutSpecs: SpecDefinition[];
  /** bracket -> rating. Rank and record are derived from it. */
  ratings: Map<string, number>;
  /** Blizzard 404s the profile endpoints once this is set. */
  deleted: boolean;
}

interface SeasonState {
  id: number;
  startsAt: number;
  endsAt: number | null;
  name: string | null;
}

export interface WorldOptions {
  regions?: WorldRegion[];
  season?: number;
  players?: number;
  /**
   * Restrict the published ladders. Omitted, the world publishes all 85,
   * which is what exercises `isIngestableBracket` on every sweep.
   */
  brackets?: string[];
  seed?: number;
  /** Fraction of players who rank in three or more brackets. */
  multiBracketShare?: number;
  seasonStart?: string;
}

/** Deterministic PRNG — no `Math.random` anywhere in the fixture. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CORE_BRACKETS = ['2v2', '3v3', 'rbg'];
export const AGGREGATE_BRACKETS = ['shuffle-overall', 'blitz-overall'];

/** Every bracket Blizzard publishes: 3 core, 2 aggregates, 2 per spec. */
export function allBrackets(): string[] {
  return [
    ...CORE_BRACKETS,
    ...AGGREGATE_BRACKETS,
    ...SPECS.flatMap((spec) => [
      `shuffle-${spec.classSlug}-${spec.specSlug}`,
      `blitz-${spec.classSlug}-${spec.specSlug}`,
    ]),
  ];
}

/**
 * A mutable in-memory model of Blizzard, shared by every integration test.
 *
 * Scenarios are expressed as mutations between sweeps — a player climbs, a
 * player vanishes, a ladder is retired, a season ends — which is what makes the
 * out-of-scope, new-player and rollover suites writable at all. `FakeBlizzard`
 * serves whatever the World currently says.
 */
export class World {
  readonly regions: WorldRegion[];
  readonly players = new Map<number, WorldPlayer>();
  private readonly seasons = new Map<WorldRegion, SeasonState>();
  private readonly seasonHistory = new Map<WorldRegion, SeasonState[]>();
  private readonly published = new Map<WorldRegion, Set<string>>();
  private readonly failures = new Map<string, number>();
  private readonly corruptions = new Map<string, unknown>();
  private readonly random: () => number;
  private nextId: number;

  private constructor(options: Required<Omit<WorldOptions, 'brackets'>> & { brackets: string[] }) {
    this.regions = options.regions;
    this.random = mulberry32(options.seed);
    this.nextId = 100_000_000;

    const startsAt = Date.parse(options.seasonStart);

    for (const [index, region] of this.regions.entries()) {
      // Regions stagger by up to 32 hours, which is the whole reason the season
      // purge is scoped per region.
      const regionStart = startsAt + index * 13 * 3_600_000;
      const season: SeasonState = {
        id: options.season,
        startsAt: regionStart,
        endsAt: null,
        name: `Player vs. Player (Season ${options.season})`,
      };
      this.seasons.set(region, season);
      this.seasonHistory.set(
        region,
        // A couple of finished seasons behind the live one, so the archive has
        // something to work through.
        [options.season - 2, options.season - 1].map((id) => ({
          id,
          startsAt: regionStart - (options.season - id) * 90 * 86_400_000,
          endsAt: regionStart - (options.season - id - 1) * 90 * 86_400_000,
          name: `Player vs. Player (Season ${id})`,
        })),
      );
      this.published.set(region, new Set(options.brackets));
    }

    this.populate(options.players, options.multiBracketShare);
  }

  static seed(options: WorldOptions = {}): World {
    return new World({
      regions: options.regions ?? ['us', 'eu'],
      season: options.season ?? 42,
      players: options.players ?? 400,
      brackets: options.brackets ?? allBrackets(),
      seed: options.seed ?? 1,
      multiBracketShare: options.multiBracketShare ?? 0.35,
      seasonStart: options.seasonStart ?? '2026-08-18T15:00:00.000Z',
    });
  }

  // ---------------------------------------------------------------- read side

  seasonIndex(region: WorldRegion) {
    const current = this.season(region);
    const history = this.seasonHistory.get(region) ?? [];

    return {
      seasons: [...history, current].map((season) => ({ id: season.id })),
      current_season: { id: current.id },
      last_completed_season: history.length > 0 ? { id: history.at(-1)!.id } : undefined,
    };
  }

  seasonPayload(region: WorldRegion, seasonId: number) {
    const season = [...(this.seasonHistory.get(region) ?? []), this.season(region)].find(
      (entry) => entry.id === seasonId,
    );
    if (!season) return null;

    return {
      id: season.id,
      season_start_timestamp: season.startsAt,
      // Absent, not null, while the season runs — Blizzard adds the field only
      // once the season has ended, and the schema is strict about that.
      ...(season.endsAt === null ? {} : { season_end_timestamp: season.endsAt }),
      season_name: season.name,
    };
  }

  season(region: WorldRegion): SeasonState {
    const season = this.seasons.get(region);
    if (!season) throw new Error(`region ${region} is not in this world`);

    return season;
  }

  brackets(region: WorldRegion): string[] {
    return [...(this.published.get(region) ?? [])];
  }

  /** Everyone ranked in a bracket, ordered by rating, with ranks applied. */
  ladder(region: WorldRegion, seasonId: number, bracket: string) {
    const ranked = [...this.players.values()]
      .filter((player) => player.region === region && player.ratings.has(bracket))
      .sort((left, right) => right.ratings.get(bracket)! - left.ratings.get(bracket)!);

    return {
      season: { id: seasonId },
      name: bracket,
      bracket: { id: 1, type: bracket.toUpperCase() },
      entries: ranked.map((player, index) => {
        const rating = player.ratings.get(bracket)!;
        const played = 20 + (rating % 40);

        return {
          character: {
            id: player.id,
            name: player.name,
            realm: { id: player.realmId, slug: player.realmSlug },
          },
          faction: { type: player.faction },
          rank: index + 1,
          rating,
          season_match_statistics: {
            played,
            won: Math.round(played * 0.55),
            lost: played - Math.round(played * 0.55),
          },
        };
      }),
    };
  }

  profilePayload(player: WorldPlayer) {
    return {
      id: player.id,
      name: player.name,
      race: { id: 10, name: 'Blood Elf' },
      character_class: { id: player.spec.classId, name: player.spec.className },
      active_spec: { id: player.spec.specId, name: player.spec.specName },
      realm: { id: player.realmId, slug: player.realmSlug, name: realmDisplayName(player) },
      faction: {
        type: player.faction,
        name: player.faction === 'HORDE' ? 'Horde' : 'Alliance',
      },
      level: 90,
      gender: { type: 'FEMALE', name: 'Female' },
      guild: { id: 1, name: 'veow' },
      average_item_level: 278,
      equipped_item_level: 278,
      last_login_timestamp: 1_767_225_600_000,
      // Blizzard sends id and name alongside the rendered string, and the
      // schema requires all three — a title with only `display_string` fails
      // the whole profile parse.
      active_title: { id: 654, name: 'Gladiator', display_string: `Gladiator ${player.name}` },
    };
  }

  /**
   * One loadout per spec the character has saved, each with its own hero tree.
   * The active spec is the one `profilePayload` reports.
   */
  specsPayload(player: WorldPlayer) {
    return {
      specializations: player.loadoutSpecs.map((spec) => {
        const isActive = spec.specId === player.spec.specId;
        const tree = spec.heroTrees[isActive ? player.heroTreeIndex : 0];

        return {
          specialization: { id: spec.specId, name: spec.specName },
          loadouts: [
            // An inactive loadout listed first, so "take the active one" is
            // actually exercised rather than "take the first one".
            {
              is_active: false,
              talent_loadout_code: `INACTIVE-${spec.specId}`,
              selected_hero_talent_tree: spec.heroTrees[1] ?? spec.heroTrees[0],
            },
            {
              is_active: true,
              talent_loadout_code: `CODE-${spec.specId}`,
              selected_hero_talent_tree: tree,
            },
          ],
        };
      }),
      active_specialization: { id: player.spec.specId, name: player.spec.specName },
      // Blizzard sends this alongside the loadouts, and it matches the active
      // loadout's tree. `saveProfileSpecs` reads `profile.heroTalentTree` from
      // here and nowhere else, so omitting it leaves that field null even
      // though the loadouts carry the answer.
      active_hero_talent_tree: player.spec.heroTrees[player.heroTreeIndex],
    };
  }

  findPlayer(region: WorldRegion, realmSlug: string, name: string): WorldPlayer | undefined {
    return [...this.players.values()].find(
      (player) =>
        player.region === region &&
        player.realmSlug === realmSlug &&
        player.name.toLowerCase() === name.toLowerCase(),
    );
  }

  /** Status to fail a route with, or undefined to serve it normally. */
  failureFor(region: WorldRegion, key: string): number | undefined {
    return this.failures.get(`${region}:${key}`);
  }

  corruptionFor(region: WorldRegion, key: string): unknown {
    return this.corruptions.get(`${region}:${key}`);
  }

  // --------------------------------------------------------------- write side

  addPlayers(count: number, options: { region: WorldRegion; brackets?: string[] }): WorldPlayer[] {
    const added: WorldPlayer[] = [];

    for (let index = 0; index < count; index += 1) {
      added.push(this.createPlayer(options.region, options.brackets));
    }

    return added;
  }

  dropFromBracket(playerId: number, bracket: string): void {
    this.player(playerId).ratings.delete(bracket);
  }

  dropFromAllBrackets(playerId: number): void {
    this.player(playerId).ratings.clear();
  }

  /** Blizzard stops publishing a ladder — a spec removed between expansions. */
  retireBracket(region: WorldRegion, bracket: string): void {
    this.published.get(region)?.delete(bracket);
  }

  publishBracket(region: WorldRegion, bracket: string): void {
    this.published.get(region)?.add(bracket);
  }

  rename(playerId: number, name: string): void {
    this.player(playerId).name = name;
  }

  /** Moves a character onto another spec, keeping their saved loadouts. */
  respec(playerId: number, specSlug: string): void {
    const player = this.player(playerId);
    const spec = SPECS.find(
      (candidate) =>
        candidate.classSlug === player.spec.classSlug && candidate.specSlug === specSlug,
    );
    if (!spec) throw new Error(`${player.spec.classSlug} has no spec ${specSlug}`);

    player.spec = spec;
    if (!player.loadoutSpecs.some((entry) => entry.specId === spec.specId)) {
      player.loadoutSpecs.push(spec);
    }
  }

  setRating(playerId: number, bracket: string, rating: number): void {
    this.player(playerId).ratings.set(bracket, rating);
  }

  /** Stamps an end date onto the season record, which is how Blizzard signals it. */
  endSeason(region: WorldRegion, at: Date): void {
    this.season(region).endsAt = at.getTime();
  }

  /** Files the current season into history and makes `seasonId` the live one. */
  rollover(region: WorldRegion, seasonId: number, startsAt: Date): void {
    const finished = this.season(region);
    if (finished.endsAt === null) finished.endsAt = startsAt.getTime();
    this.seasonHistory.get(region)?.push(finished);

    this.seasons.set(region, {
      id: seasonId,
      startsAt: startsAt.getTime(),
      endsAt: null,
      name: `Player vs. Player (Season ${seasonId})`,
    });

    // A new season resets every ladder in that region.
    for (const player of this.players.values()) {
      if (player.region === region) player.ratings.clear();
    }
  }

  // ----------------------------------------------------------- fault injection

  /** Fail a route with a status. The key is a bracket, or `index` / `season`. */
  fail(region: WorldRegion, key: string, status: number): void {
    this.failures.set(`${region}:${key}`, status);
  }

  clearFailures(): void {
    this.failures.clear();
  }

  /** Serve a structurally wrong payload, to exercise the zod boundary. */
  corrupt(region: WorldRegion, key: string, payload: unknown): void {
    this.corruptions.set(`${region}:${key}`, payload);
  }

  /** The character is gone: profile endpoints 404, ladders are untouched. */
  deleteCharacter(playerId: number): void {
    this.player(playerId).deleted = true;
  }

  // ------------------------------------------------------------------ internals

  player(playerId: number): WorldPlayer {
    const player = this.players.get(playerId);
    if (!player) throw new Error(`no player ${playerId} in this world`);

    return player;
  }

  private populate(count: number, multiBracketShare: number): void {
    const perRegion = Math.max(1, Math.floor(count / this.regions.length));

    for (const [index, region] of this.regions.entries()) {
      for (let created = 0; created < perRegion; created += 1) {
        const player = this.createPlayer(region);

        if (this.random() < multiBracketShare) {
          this.spreadAcrossBrackets(player);
        }

        // One shared characterId across us and eu: identity is only unique
        // within a region, and a document keyed on the id alone would collide.
        if (index === 1 && created === 0) {
          this.players.delete(player.id);
          const twin = [...this.players.values()].find((other) => other.region === this.regions[0]);
          if (twin) player.id = twin.id;
          this.players.set(player.id, player);
        }
      }
    }
  }

  private createPlayer(region: WorldRegion, brackets?: string[]): WorldPlayer {
    const names = NAME_POOL[region];
    const realms = REALMS[region];
    const spec = SPECS[Math.floor(this.random() * SPECS.length)];
    const realm = realms[Math.floor(this.random() * realms.length)];
    const id = this.nextId;
    this.nextId += 1;

    const player: WorldPlayer = {
      id,
      region,
      name: `${names[Math.floor(this.random() * names.length)]}${id % 1000}`,
      realmId: realm[0],
      realmSlug: realm[1],
      faction: this.random() < 0.5 ? 'HORDE' : 'ALLIANCE',
      spec,
      heroTreeIndex: this.random() < 0.5 ? 0 : 1,
      loadoutSpecs: [spec],
      ratings: new Map(),
      deleted: false,
    };

    const chosen = brackets ?? [this.defaultBracketFor(player)];
    for (const bracket of chosen) {
      player.ratings.set(bracket, this.rating());
    }

    this.players.set(id, player);

    return player;
  }

  /** A spec-split ladder matching the character, so the key is never a lie. */
  private defaultBracketFor(player: WorldPlayer): string {
    const family = this.random() < 0.5 ? 'shuffle' : 'blitz';

    return `${family}-${player.spec.classSlug}-${player.spec.specSlug}`;
  }

  private spreadAcrossBrackets(player: WorldPlayer): void {
    player.ratings.set('2v2', this.rating());
    player.ratings.set('3v3', this.rating());
    player.ratings.set(`shuffle-${player.spec.classSlug}-${player.spec.specSlug}`, this.rating());

    // A second spec of the same class, so one character legitimately holds
    // several shuffle ratings at once.
    const sibling = SPECS.find(
      (candidate) =>
        candidate.classSlug === player.spec.classSlug && candidate.specId !== player.spec.specId,
    );

    if (sibling) {
      player.ratings.set(`shuffle-${sibling.classSlug}-${sibling.specSlug}`, this.rating());
      player.loadoutSpecs.push(sibling);
    }
  }

  private rating(): number {
    return 1400 + Math.floor(this.random() * 1400);
  }
}

function realmDisplayName(player: WorldPlayer): string {
  return player.realmSlug
    .split('-')
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

export { SPECS, SPEC_BY_SLUG };
