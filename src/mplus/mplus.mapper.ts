import { searchNameOf } from '@denipetrov/spirit-link/search';

import type { RaiderIoRegion } from '../raiderio/raiderio.constants.js';
import type {
  MythicPlusRanking,
  WeeklyModifier,
} from '../raiderio/schemas/mythic-plus-runs.schema.js';
import type { MplusAffixDocument } from './entities/mplus-affix.entity.js';
import {
  mplusCharacterKey,
  mplusNameKey,
  type MplusCharacterDocument,
  type MplusDungeonRun,
} from './entities/mplus-character.entity.js';
import type {
  MplusDungeonRef,
  MplusRosterMember,
  MplusRunDocument,
} from './entities/mplus-run.entity.js';
import { isFullyCovered } from './mplus-coverage.js';

/**
 * Whether a roster entry belongs to a player who opted out of public profiles.
 *
 * Three independent signals, because the payload sets all three and relying on
 * one would break if Raider.io dropped it: an explicit flag on the character, an
 * explicit flag on the realm, and the `id: 0` / `realm.slug: "anonymous"` pair
 * the data actually carries. About one roster entry in two hundred.
 */
export function isAnonymised(member: {
  character: {
    id: number;
    anonymized?: boolean | null;
    realm: { slug: string; anonymized?: boolean | null };
  };
}): boolean {
  const { character } = member;

  return (
    character.anonymized === true ||
    character.realm.anonymized === true ||
    character.id === 0 ||
    character.realm.slug === 'anonymous'
  );
}

function dungeonRefOf(dungeon: MythicPlusRanking['run']['dungeon']): MplusDungeonRef {
  return {
    id: dungeon.id,
    name: dungeon.name,
    slug: dungeon.slug,
    shortName: dungeon.short_name ?? null,
  };
}

/** Flattens one leaderboard ranking into the run document stored for it. */
export function toRunDocument(
  ranking: MythicPlusRanking,
  region: RaiderIoRegion,
  fetchedAt: Date,
): MplusRunDocument {
  const { run } = ranking;

  const roster: MplusRosterMember[] = run.roster.map((entry) => {
    const anonymised = isAnonymised(entry);

    return {
      rioCharacterId: entry.character.id,
      characterName: entry.character.name,
      realmSlug: entry.character.realm.slug,
      realmId: entry.character.realm.wowRealmId ?? null,
      region: entry.character.region.slug,
      classId: entry.character.class.id,
      className: entry.character.class.name,
      specId: entry.character.spec?.id ?? null,
      specName: entry.character.spec?.name ?? null,
      role: entry.role,
      faction: entry.character.faction ?? null,
      anonymized: anonymised,
    };
  });

  return {
    season: run.season,
    region,
    keystoneRunId: run.keystone_run_id,
    rank: ranking.rank,
    score: ranking.score,
    dungeon: dungeonRefOf(run.dungeon),
    mythicLevel: run.mythic_level,
    clearTimeMs: run.clear_time_ms,
    keystoneTimeMs: run.keystone_time_ms ?? null,
    timeRemainingMs: run.time_remaining_ms ?? null,
    numChests: run.num_chests ?? null,
    completedAt: new Date(run.completed_at),
    affixIds: run.weekly_modifiers.map((modifier) => modifier.id),
    faction: run.faction ?? null,
    roster,
    rosterKeys: run.roster
      .filter((entry) => !isAnonymised(entry))
      .map((entry) =>
        mplusCharacterKey(
          entry.character.region.slug,
          entry.character.realm.slug,
          entry.character.name,
        ),
      ),
    fetchedAt,
  };
}

/** Flattens a weekly modifier into the affix document stored once for it. */
export function toAffixDocument(modifier: WeeklyModifier, updatedAt: Date): MplusAffixDocument {
  return {
    id: modifier.id,
    name: modifier.name,
    slug: modifier.slug ?? null,
    description: modifier.description ?? null,
    icon: modifier.icon ?? null,
    updatedAt,
  };
}

/**
 * Sums a set of best runs into the stat the front end sorts on.
 *
 * Rounded to one decimal because scores arrive with one (515.3), and summing
 * eight floats produces trailing binary noise that would show up on a board as
 * 1841.2000000000003.
 *
 * The single definition of the score. Every write path — the pass, the merge
 * below, the sync endpoint — goes through it, so `mythicScore` cannot mean one
 * thing on one path and something slightly different on another.
 */
export function scoreOf(dungeonRuns: readonly MplusDungeonRun[]): number {
  return Math.round(dungeonRuns.reduce((sum, run) => sum + run.score, 0) * 10) / 10;
}

/**
 * Keeps the better run for each dungeon across what is stored and what just
 * arrived. This is what makes `mythicScore` monotonic.
 *
 * A real Mythic+ score never falls: it is your best run in each dungeon, ever.
 * A score recomputed from a *window* of the leaderboard can, because a run that
 * sat inside the top 20,020 last pass can be pushed out of it by other people's
 * newer runs while the player does nothing. Recomputing blindly would show that
 * as the player losing points.
 *
 * Merging per dungeon rather than clamping the total is the part worth keeping.
 * Clamping (`max(stored, computed)`) would leave the document describing a set
 * of runs that does not add up to the score printed on it, and
 * `dungeonsCovered` counting a different set again — so invariant I12 could
 * never hold and nothing downstream could recompute or audit the number. Here
 * the sum is monotonic *because* each term is, and the document stays
 * self-consistent.
 *
 * A tie keeps the stored run: equal scores make the newcomer no better, and
 * holding still keeps `dungeonRuns` stable for readers diffing passes.
 */
export function mergeDungeonRuns(
  stored: readonly MplusDungeonRun[],
  incoming: readonly MplusDungeonRun[],
): MplusDungeonRun[] {
  const best = new Map<number, MplusDungeonRun>();

  for (const run of stored) best.set(run.dungeon.id, run);

  for (const run of incoming) {
    const previous = best.get(run.dungeon.id);
    if (previous && previous.score >= run.score) continue;

    best.set(run.dungeon.id, run);
  }

  return [...best.values()].sort((left, right) => right.score - left.score);
}

/** The fields derived from a character's best runs, never written apart from them. */
export type DerivedFromRuns = 'mythicScore' | 'dungeonsCovered' | 'isFullyCovered' | 'dungeonRuns';

/**
 * Applies a set of best runs to a document, with the fields derived from it.
 * `seasonDungeons` is how many dungeons the season lists, 0 when unknown.
 */
export function withDungeonRuns<T>(
  document: T,
  dungeonRuns: MplusDungeonRun[],
  seasonDungeons: number,
): T & Pick<MplusCharacterDocument, DerivedFromRuns> {
  return {
    ...document,
    mythicScore: scoreOf(dungeonRuns),
    dungeonsCovered: dungeonRuns.length,
    isFullyCovered: isFullyCovered(dungeonRuns.length, seasonDungeons),
    dungeonRuns,
  };
}

/**
 * Accumulates each character's best run per dungeon as pages arrive.
 *
 * Folding while streaming rather than storing every roster row and aggregating
 * afterwards: a region is ~20,020 runs x 5 members = ~100,000 rows, but only
 * ~8 entries per *character* survive the fold, so the working set is bounded by
 * distinct characters rather than by rows.
 *
 * "Best" is the highest-scoring run in that dungeon. Ties go to the first seen,
 * which is the higher-ranked one, since a board's pages arrive in rank order.
 *
 * The identity and profile fields — name, realm, faction, class, spec, race,
 * role — come from the character's highest-scoring run anywhere in the region.
 * The pass reads one dungeon board after another, so the first run seen is
 * the first dungeon's, not the best; taking the profile from it would make a
 * character's spec depend on which dungeon happens to be read first.
 */
export class MplusCharacterAccumulator {
  private readonly characters = new Map<
    string,
    {
      document: Omit<MplusCharacterDocument, DerivedFromRuns>;
      best: Map<number, MplusDungeonRun>;
      /** The score of the run the document's profile was taken from. */
      profileScore: number;
    }
  >();

  constructor(
    private readonly season: string,
    private readonly seasonId: number | null,
    /** The region every character is filed under: the board being read. */
    private readonly region: RaiderIoRegion,
    /** How many dungeons the season lists, for `isFullyCovered`; 0 when unknown. */
    private readonly seasonDungeons: number,
  ) {}

  get size(): number {
    return this.characters.size;
  }

  /**
   * Folds one ranking's roster in.
   *
   * Anonymised members are skipped: they all share `id: 0` and the placeholder
   * realm `anonymous`, so every anonymised player in a region would fold into
   * one document with a meaningless name. They stay in the run's own roster,
   * where the party is a fact rather than a lookup key.
   */
  add(ranking: MythicPlusRanking, updatedAt: Date): void {
    const { run } = ranking;
    const dungeon = dungeonRefOf(run.dungeon);

    for (const entry of run.roster) {
      if (isAnonymised(entry)) continue;

      const { character } = entry;
      const key = mplusCharacterKey(character.region.slug, character.realm.slug, character.name);
      const existing = this.characters.get(key) ?? {
        document: this.documentOf(entry, key, updatedAt),
        best: new Map<number, MplusDungeonRun>(),
        profileScore: ranking.score,
      };
      if (!this.characters.has(key)) this.characters.set(key, existing);

      // Strictly better only: a tie keeps the profile of the run seen first.
      if (ranking.score > existing.profileScore) {
        existing.document = this.documentOf(entry, key, updatedAt);
        existing.profileScore = ranking.score;
      }

      const previous = existing.best.get(dungeon.id);
      if (previous && previous.score >= ranking.score) continue;

      existing.best.set(dungeon.id, {
        dungeon,
        keystoneRunId: run.keystone_run_id,
        mythicLevel: run.mythic_level,
        score: ranking.score,
        clearTimeMs: run.clear_time_ms,
        timeRemainingMs: run.time_remaining_ms ?? null,
        numChests: run.num_chests ?? null,
        completedAt: new Date(run.completed_at),
        specId: character.spec?.id ?? null,
        role: entry.role,
      });
    }
  }

  /** A character's identity and profile, as one roster entry describes it. */
  private documentOf(
    entry: MythicPlusRanking['run']['roster'][number],
    key: string,
    updatedAt: Date,
  ): Omit<MplusCharacterDocument, DerivedFromRuns> {
    const { character } = entry;

    return {
      season: this.season,
      seasonId: this.seasonId,
      region: this.region,
      key,
      realmSlug: character.realm.slug,
      nameKey: mplusNameKey(character.name),
      characterName: character.name,
      searchName: searchNameOf(character.name),
      characterType: 'M+',
      // Known only once storage is read: the live write fills it in, and the
      // archive, written once, has none.
      previousMythicScore: null,
      rioCharacterId: character.id || null,
      realmId: character.realm.wowRealmId ?? null,
      realmName: character.realm.name,
      faction: character.faction ?? null,
      profile: {
        classId: character.class.id,
        className: character.class.name,
        specId: character.spec?.id ?? null,
        specName: character.spec?.name ?? null,
        raceId: character.race?.id ?? null,
        raceName: character.race?.name ?? null,
        level: character.level ?? null,
        role: entry.role,
      },
      updatedAt,
    };
  }

  /**
   * The finished documents for this region, with the score this pass alone saw.
   *
   * Deliberately *not* merged with what is stored: the accumulator knows only
   * this pass. The merge against the stored document happens in
   * `MplusRepository.upsertCharacters`, which is the one place that has both
   * halves — and doing it there means the sync endpoint gets the same treatment
   * without a second implementation.
   */
  drain(): MplusCharacterDocument[] {
    const documents = [...this.characters.values()].map(({ document, best }) =>
      withDungeonRuns(
        document,
        [...best.values()].sort((left, right) => right.score - left.score),
        this.seasonDungeons,
      ),
    );

    this.characters.clear();

    return documents;
  }
}
