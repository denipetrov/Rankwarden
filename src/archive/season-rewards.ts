import type { Bracket, SpecSplitFamily } from '../blizzard/blizzard.constants.js';
import type { PvpReward } from '../blizzard/schemas/pvp-reward.schema.js';
import type { ArchiveSeasonReward } from './entities/archive.entity.js';

/** Reward bracket types that map onto one ladder each. 2v2 awards no title. */
const CORE_REWARD_BRACKETS = new Map<string, Bracket>([
  ['ARENA_2v2', '2v2'],
  ['ARENA_3v3', '3v3'],
  ['BATTLEGROUNDS', 'rbg'],
]);

/** Reward bracket types awarded per spec, and the family of ladders they name. */
const SPEC_REWARD_FAMILIES = new Map<string, SpecSplitFamily>([
  ['SHUFFLE', 'shuffle'],
  ['BLITZ', 'blitz'],
]);

/**
 * A class or spec name as Blizzard's bracket names spell it: lowercased with the
 * spaces taken out, so "Death Knight" / "Beast Mastery" give
 * `shuffle-deathknight-beastmastery`'s two halves.
 */
export function bracketSlug(name: string): string {
  return name.toLowerCase().replaceAll(' ', '');
}

/** The `class-spec` tail of a per-spec ladder, e.g. `warrior-fury`. */
export function specLadderSuffix(className: string, specName: string): string {
  return `${bracketSlug(className)}-${bracketSlug(specName)}`;
}

/** Spec ids a set of rewards needs resolving before it can be mapped. */
export function specIdsIn(rewards: readonly PvpReward[]): number[] {
  return [
    ...new Set(
      rewards
        .filter((reward) => SPEC_REWARD_FAMILIES.has(reward.bracket.type))
        .flatMap((reward) => (reward.specialization ? [reward.specialization.id] : [])),
    ),
  ];
}

/**
 * Attaches each reward to the ladder it was earned on.
 *
 * `specLadders` maps a Blizzard spec id to its `class-spec` suffix. `published`
 * is the season's own bracket list: a reward whose ladder is not on it has
 * nothing to sit next to, and more likely means the mapping has drifted than
 * that the ladder exists unlisted. An empty list means the season's brackets
 * could not be read, and then nothing is filtered on it.
 *
 * A reward that cannot be placed is returned in `unmatched` rather than guessed
 * at, so the caller can say what it dropped.
 */
export function mapSeasonRewards(
  rewards: readonly PvpReward[],
  specLadders: ReadonlyMap<number, string>,
  published: ReadonlySet<Bracket>,
): { rewards: ArchiveSeasonReward[]; unmatched: string[] } {
  const mapped: ArchiveSeasonReward[] = [];
  const unmatched: string[] = [];

  for (const reward of rewards) {
    const bracket = ladderFor(reward, specLadders);
    const described = describe(reward);

    if (!bracket) {
      unmatched.push(`${described} (no ladder for it)`);
      continue;
    }
    if (published.size > 0 && !published.has(bracket)) {
      unmatched.push(`${described} (${bracket} is not published this season)`);
      continue;
    }

    mapped.push({
      bracket,
      faction: reward.faction?.type ?? null,
      ratingCutoff: reward.rating_cutoff,
      title: reward.achievement.name,
      achievementId: reward.achievement.id,
      specialization: reward.specialization
        ? { id: reward.specialization.id, name: reward.specialization.name }
        : null,
    });
  }

  // Blizzard's order carries no meaning, and a stable one keeps re-fetches from
  // looking like changes.
  mapped.sort(
    (left, right) =>
      left.bracket.localeCompare(right.bracket) ||
      (left.faction ?? '').localeCompare(right.faction ?? ''),
  );

  return { rewards: mapped, unmatched };
}

function ladderFor(reward: PvpReward, specLadders: ReadonlyMap<number, string>): Bracket | null {
  const core = CORE_REWARD_BRACKETS.get(reward.bracket.type);
  if (core) return core;

  const family = SPEC_REWARD_FAMILIES.get(reward.bracket.type);
  if (!family || !reward.specialization) return null;

  const suffix = specLadders.get(reward.specialization.id);

  return suffix ? `${family}-${suffix}` : null;
}

function describe(reward: PvpReward): string {
  const spec = reward.specialization
    ? ` spec ${reward.specialization.id} (${reward.specialization.name})`
    : '';
  const faction = reward.faction ? ` ${reward.faction.type}` : '';

  return `${reward.bracket.type}${spec}${faction}`;
}
