import { searchNameOf } from '@denipetrov/spirit-link/search';

import type { BossRanking } from '../raiderio/schemas/boss-rankings.schema.js';
import type { RaidRanking, RankedGuild } from '../raiderio/schemas/raid-rankings.schema.js';
import type { BossRankedGuild } from './entities/boss.entity.js';
import type { GuildDocument } from './entities/guild.entity.js';
import type {
  RaidEncounter,
  RaidEncounterKill,
  RaidEncounterPull,
  RaidRankedGuild,
} from './entities/raid.entity.js';

function toDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const at = Date.parse(value);

  return Number.isFinite(at) ? new Date(at) : null;
}

/** The guild a ranking entry describes, as the `guilds` collection stores it. */
export function toGuildDocument(entry: { guild: RankedGuild }, updatedAt: Date): GuildDocument {
  const { guild } = entry;

  return {
    id: guild.id,
    name: guild.name,
    searchName: searchNameOf(guild.name),
    faction: guild.faction ?? null,
    logo: guild.logo ?? null,
    region: guild.region?.slug ?? null,
    realm: guild.realm?.slug ? { slug: guild.realm.slug, name: guild.realm.name ?? null } : null,
    updatedAt,
  };
}

/**
 * A ranking entry as its raid stores it: the guild by id, and each boss tied to
 * the raid's own encounter by slug.
 */
export function toRankedGuild(
  entry: RaidRanking,
  encounters: readonly RaidEncounter[],
): RaidRankedGuild {
  const idBySlug = new Map(encounters.map((encounter) => [encounter.slug, encounter.id]));

  const encountersPulled: RaidEncounterPull[] = (entry.encountersPulled ?? []).map((pull) => ({
    encounterId: idBySlug.get(pull.slug) ?? null,
    slug: pull.slug,
    numPulls: pull.numPulls ?? null,
    pullStartedAt: toDate(pull.pullStartedAt),
    bestPercent: pull.bestPercent ?? null,
    isDefeated: pull.isDefeated === true,
  }));

  const encountersDefeated: RaidEncounterKill[] = (entry.encountersDefeated ?? []).map((kill) => ({
    encounterId: idBySlug.get(kill.slug) ?? null,
    slug: kill.slug,
    firstDefeated: toDate(kill.firstDefeated),
    lastDefeated: toDate(kill.lastDefeated),
  }));

  return {
    rank: entry.rank,
    regionRank: entry.regionRank ?? null,
    guildId: entry.guild.id,
    encountersPulled,
    encountersDefeated,
  };
}

/**
 * A boss-ranking entry as its boss stores it: the guild by id, its place, its
 * item level, and its **first** kill — the earliest of the kills listed, which
 * is the first one listed on every board checked. A guild ranked for progress
 * it has not turned into a kill has no kill to report.
 */
export function toBossRankedGuild(entry: BossRanking): BossRankedGuild {
  const kills = (entry.encountersDefeated ?? [])
    .map((kill) => ({ kill, at: toDate(kill.firstDefeated) }))
    .filter((dated): dated is { kill: (typeof dated)['kill']; at: Date } => dated.at !== null)
    .sort((left, right) => left.at.getTime() - right.at.getTime());
  const first = kills[0];

  return {
    guildId: entry.guild.id,
    rank: entry.rank,
    itemLevelAvg: entry.itemLevelAvg ?? null,
    attempts: first?.kill.attempts ?? null,
    firstDefeated: first?.at ?? null,
  };
}
