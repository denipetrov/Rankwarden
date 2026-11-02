import type { RaidRankingRegion } from '../../raiderio/raiderio.constants.js';
import type { RaidBoards } from './raid.entity.js';

/**
 * One guild's place on one boss's board: who killed the boss first, at one
 * difficulty, on `world` or one region.
 *
 * `attempts` and `firstDefeated` are the guild's **first** kill of the boss —
 * upstream lists every kill, oldest first, and only the first is kept. A guild
 * ranked for its progress on a boss it has not killed yet has both null.
 */
export interface BossRankedGuild {
  /** The guild's `id` in the `guilds` collection. */
  guildId: number;
  /** Place on this board, as served. */
  rank: number;
  /** The guild's average item level, as upstream reports it. */
  itemLevelAvg: number | null;
  /** Pulls before the first kill. Upstream sends none for many guilds and every old raid. */
  attempts: number | null;
  /** When the guild first killed the boss; null while it has not. */
  firstDefeated: Date | null;
}

/**
 * One boss of one raid: an entry of the raid's `encounters`, with its own
 * boards.
 *
 * Keyed by the encounter's `id`, which is unique across every raid — 245 of
 * them, checked live (2026-11-02). Its `slug` is not: a re-release's boss can
 * share it with the original's (`artificer-xymox`), so a boss is found by
 * `raidId` and `slug` together.
 */
export interface BossDocument {
  /** The encounter id, as the raid's `encounters` list it. */
  id: number;
  /** The `id` of the raid in `raids` the boss belongs to. */
  raidId: number;
  name: string;
  slug: string;
  /** When a catalogue walk last listed the boss on its raid. */
  catalogueUpdatedAt: Date;
  /**
   * The first fifty guilds to kill the boss, per board and difficulty, as
   * `bossRankings.world.mythic`. Absent until the rankings job reads a board.
   */
  bossRankings?: Partial<Record<RaidRankingRegion, RaidBoards<BossRankedGuild[]>>>;
  /** When each board was last read, in the same shape. */
  bossRankingsUpdatedAt?: Partial<Record<RaidRankingRegion, RaidBoards<Date>>>;
  /** When Raider.io last refused a board, cleared once it is read. */
  bossRankingsRefusedAt?: Partial<Record<RaidRankingRegion, RaidBoards<Date>>>;
}
