import type { RaiderIoRegion } from '../../raiderio/raiderio.constants.js';
import type { CharacterType } from '../../leaderboard/entities/character.entity.js';
import type { MplusDungeonRef } from './mplus-run.entity.js';

/**
 * A character's best run in one dungeon this season, as far as the ingested
 * leaderboard shows. One entry per dungeon; `keystoneRunId` joins to
 * `mplus_runs`.
 */
export interface MplusDungeonRun {
  dungeon: MplusDungeonRef;
  keystoneRunId: number;
  mythicLevel: number;
  score: number;
  clearTimeMs: number;
  /**
   * Milliseconds under par — what the owner asked for to tell a timed run from
   * a failed one. Worth knowing that the leaderboard never publishes a depleted
   * run, so this is always positive in practice; the field is kept because
   * "timed by 14 seconds" and "timed by 8 minutes" are very different runs.
   */
  timeRemainingMs: number | null;
  numChests: number | null;
  completedAt: Date;
  /** The spec and role this character played it on, which can differ per run. */
  specId: number | null;
  role: string;
}

/** Class, spec and race as Raider.io reports them, bundled in the same response. */
export interface MplusCharacterProfile {
  classId: number;
  className: string;
  specId: number | null;
  specName: string | null;
  raceId: number | null;
  raceName: string | null;
  level: number | null;
  /** The role played most recently among the stored runs. */
  role: string | null;
}

/**
 * One document per character per M+ season and region.
 *
 * **A separate collection from `characters`, deliberately.** Three reasons, each
 * of which would produce plausible-looking wrong data on its own:
 *
 * 1. Raider.io's character id is not Blizzard's. Verified against the Blizzard
 *    profile API: exxibae-stormrage is 258653729 to Blizzard and 228420218 to
 *    Raider.io. Both id spaces are nine-digit integers in the same range, so a
 *    shared `characterId` under a unique index collides silently.
 * 2. About one roster entry in two hundred is anonymised, and every one of them
 *    carries `id: 0`, so the id is not even unique within Raider.io's own data.
 * 3. M+ and PvP number their seasons separately — M+ season 2 of Midnight is
 *    Blizzard season 18 while the live PvP season is 42 — and
 *    `SeasonTransitionService.purge()` deletes from `characters` by
 *    `{ seasonId, region }` with no type filter. PvP season 18 is a real
 *    historic season, so retiring it would have deleted M+ documents.
 *
 * The cost is that a player who both raids the M+ ladder and plays rated PvP
 * has a document in each collection, joinable only on `region + realmSlug +
 * nameKey`. `characterType` is carried here anyway so the two read alike.
 *
 * Identity is `season + key`, where `key` is `region/realmSlug/lowercased-name` —
 * Blizzard's own notion of a character, needing no id from either upstream. The
 * same key is mirrored onto every run's `rosterKeys`, so "which characters are
 * still on the board" is one comparison rather than a tuple join.
 */
export interface MplusCharacterDocument {
  /** Raider.io's season slug, e.g. `season-mn-2`. */
  season: string;
  /** Blizzard's M+ season id, for reference. Nothing keys off it. */
  seasonId: number | null;
  region: RaiderIoRegion;
  /**
   * `region/realmSlug/lowercased-name`, e.g. `us/stormrage/exxibae`.
   *
   * The one canonical identity for a Mythic+ character, built by
   * `mplusCharacterKey`. It is what `mplus_runs.rosterKeys` stores, so the
   * orphan cleanup is a set difference rather than a join, and it is what a
   * chunked read can `$in` on — a four-field tuple could do neither.
   */
  key: string;
  realmSlug: string;
  /** Lowercased character name, kept separate so a name lookup needs no parsing. */
  nameKey: string;
  characterName: string;
  /** Always `M+` here, so a reader of either collection can tell them apart. */
  characterType: CharacterType;
  /** Raider.io's own id. Stored for linking back to raider.io, never as a key. */
  rioCharacterId: number | null;
  /** Blizzard's realm id (`wowRealmId`), when the payload carried one. */
  realmId: number | null;
  realmName: string | null;
  faction: string | null;
  profile: MplusCharacterProfile;
  /**
   * Sum of `score` over this character's best run in each dungeon, which is the
   * stat the front end sorts on.
   *
   * **Monotonic: it never decreases while the character is stored.** A real
   * Mythic+ score cannot fall — it is your best run in each dungeon, ever — but
   * a score recomputed from a *window* of the leaderboard can, because a run
   * that was in the top 20,020 last pass can be pushed out of it by newer runs
   * without the player having done anything. Rather than clamp the total, each
   * dungeon keeps the better of its stored and freshly computed run
   * (`mergeDungeonRuns`), so the sum is monotonic by construction and still
   * equals the sum of `dungeonRuns` — a clamped total would not, and the
   * document would describe a set of runs it did not add up to.
   *
   * **Bounded by what was ingested, not by what the character played.** The feed
   * is the top ~20,020 runs per region across all dungeons, so a dungeon the
   * character has no top-20k run in contributes nothing. Measured over the top
   * 1,200 US runs, 392 of 1,096 characters appeared in exactly one dungeon and
   * only 150 in all eight — so this is not Raider.io's own mythic+ score and is
   * only comparable between characters with the same `dungeonsCovered`.
   */
  mythicScore: number;
  /** How many of the season's dungeons `mythicScore` is summed over, 1-8. */
  dungeonsCovered: number;
  /**
   * Best run per dungeon, highest score first.
   *
   * Because a dungeon's entry is kept once earned, `keystoneRunId` may point at
   * a run that has since fallen off the leaderboard and been pruned from
   * `mplus_runs`. That is deliberate — the run was real when it was recorded —
   * so a reader must treat the join as optional rather than assume it resolves.
   */
  dungeonRuns: MplusDungeonRun[];
  updatedAt: Date;
}

export const MPLUS_CHARACTERS_COLLECTION = 'mplus_characters';

/** Identity key for a character, independent of either upstream's ids. */
export function mplusCharacterKey(region: string, realmSlug: string, name: string): string {
  return `${region}/${realmSlug.toLowerCase()}/${mplusNameKey(name)}`;
}

/**
 * A name as it is looked up: NFC, then lowercased. NFC first, because the same
 * name can arrive precomposed (`ë`) or decomposed (`e` + combining `¨`), and
 * the two lowercase to different strings. Every key-building site goes through
 * this, so a name that finds a character in one place finds it everywhere.
 */
export function mplusNameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}
