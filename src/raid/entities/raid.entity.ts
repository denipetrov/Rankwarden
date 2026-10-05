import type {
  RaidDifficulty,
  RaiderIoRegion,
  RaidRankingRegion,
} from '../../raiderio/raiderio.constants.js';

/** A boss of a raid, in the order Raider.io lists them. */
export interface RaidEncounter {
  id: number;
  slug: string;
  name: string;
}

/**
 * One boss a ranked guild has pulled, from the ranking's `encountersPulled`.
 *
 * `encounterId` is the id of the matching entry in the raid's own `encounters`,
 * matched by slug — upstream's `id` here is not the encounter's — so the boss's
 * name is read from the raid document the entry is stored in. Null only if the
 * ranking names a boss the catalogue does not list.
 */
export interface RaidEncounterPull {
  encounterId: number | null;
  slug: string;
  /** Pulls up to and including the kill. Null when the guild hides its pulls. */
  numPulls: number | null;
  /** When the guild first pulled the boss. */
  pullStartedAt: Date | null;
  /** Boss health left on the best attempt; `0` once defeated. */
  bestPercent: number | null;
  isDefeated: boolean;
}

/** One boss a ranked guild has killed, from the ranking's `encountersDefeated`. */
export interface RaidEncounterKill {
  encounterId: number | null;
  slug: string;
  firstDefeated: Date | null;
  lastDefeated: Date | null;
}

/** One guild's place on one board of one raid, at one difficulty. */
export interface RaidRankedGuild {
  /** Place on this board, as served. A board can skip a rank. */
  rank: number;
  /** Place within the guild's own region; differs from `rank` on `world`. */
  regionRank: number | null;
  /** The guild's `id` in the `guilds` collection. */
  guildId: number;
  /**
   * Empty for every guild on a raid older than Shadowlands, and for a guild
   * that hides its pulls — `encountersDefeated` is then the only progress the
   * entry carries, which is why both are kept.
   */
  encountersPulled: RaidEncounterPull[];
  encountersDefeated: RaidEncounterKill[];
}

/** One value per difficulty, for the difficulties read so far. */
export type RaidBoards<T> = Partial<Record<RaidDifficulty, T>>;

/**
 * One raid, as catalogued from Raider.io's `/raiding/static-data`.
 *
 * One document per raid, keyed by Raider.io's raid `id`, which is unique
 * across every expansion. A re-release — Fated in Shadowlands, Awakened in
 * Dragonflight — is a raid of its own upstream, with its own id (the
 * original's plus 100,000,000), slug and dates, and so a document of its own
 * here: it had its own progression race, and folding it into the original
 * would lose that.
 *
 * `slug` is what the raiding endpoints take as `raid=`, which is what the
 * catalogue exists to supply.
 */
export interface RaidDocument {
  id: number;
  slug: string;
  name: string;
  shortName: string | null;
  /** Absent upstream on every raid before Shadowlands. */
  icon: string | null;
  /** The `expansion_id` whose static data listed the raid (6 is Legion). */
  expansionId: number;
  /**
   * When the raid opened and closed, per region. A raid still open carries
   * Raider.io's placeholder end, `2030-01-01`, until it is replaced by the real
   * date — the same convention a running Mythic+ season follows.
   */
  starts: Partial<Record<RaiderIoRegion, Date>>;
  ends: Partial<Record<RaiderIoRegion, Date>>;
  /** Embedded: at most a dozen, never read without their raid. */
  encounters: RaidEncounter[];
  /** When a catalogue walk last listed the raid. */
  catalogueUpdatedAt: Date;
  /**
   * Set when a complete walk no longer lists the raid, cleared if a later one
   * does. Such a raid is never stamped again, so it is left out of the
   * catalogue's freshness; the document itself is kept.
   */
  unlistedAt?: Date;
  /**
   * The top hundred guilds, per board and difficulty, best first:
   * `guilds.world.mythic`, `guilds.eu.heroic`. Written by the rankings job, one
   * board at a time; a board never read is absent, and one read with nobody on
   * it is an empty list.
   */
  guilds?: Partial<Record<RaidRankingRegion, RaidBoards<RaidRankedGuild[]>>>;
  /** When each board was last read, in the same shape. */
  guildsUpdatedAt?: Partial<Record<RaidRankingRegion, RaidBoards<Date>>>;
  /**
   * When Raider.io last refused a board (a 400 or a 404), in the same shape;
   * cleared when the board is next read. A refusal settles a board as a read
   * does, so it is not asked for again every run.
   */
  guildsRefusedAt?: Partial<Record<RaidRankingRegion, RaidBoards<Date>>>;
}

/** A raid without its boards, which is all the catalogue itself ever needs. */
export type RaidCatalogueDocument = Omit<RaidDocument, 'guilds' | 'guildsRefusedAt'>;

export const RAIDS_COLLECTION = 'raids';
