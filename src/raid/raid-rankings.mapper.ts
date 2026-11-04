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
    // Upstream sends 0 for a guild it has no item level for, and which guilds
    // get one moves from hour to hour. 0 is never a real item level.
    itemLevelAvg: entry.itemLevelAvg && entry.itemLevelAvg > 0 ? entry.itemLevelAvg : null,
    attempts: first?.kill.attempts ?? null,
    firstDefeated: first?.at ?? null,
  };
}

/**
 * A boss board as read, with each guild's item level kept from the board it
 * replaces where this read has none.
 *
 * Raider.io's `itemLevelAvg` comes and goes: a guild served 325.8 one day is
 * served 0 the next, and another the other way round (Ula'tek's world Mythic
 * board, checked live 2026-11-02 and 2026-11-03). The board is replaced whole,
 * so without this a guild's item level would vanish whenever upstream had none
 * to hand. The last value it did have is the better answer.
 */
export function keepKnownItemLevels(
  board: readonly BossRankedGuild[],
  previous: readonly BossRankedGuild[] | null,
): BossRankedGuild[] {
  const known = new Map(
    (previous ?? [])
      .filter((entry) => entry.itemLevelAvg !== null && entry.itemLevelAvg > 0)
      .map((entry) => [entry.guildId, entry.itemLevelAvg]),
  );

  return board.map((entry) =>
    entry.itemLevelAvg === null && known.has(entry.guildId)
      ? { ...entry, itemLevelAvg: known.get(entry.guildId)! }
      : entry,
  );
}
