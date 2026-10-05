import type { RaidRanking } from '../raiderio/schemas/raid-rankings.schema.js';
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
export function toGuildDocument(entry: RaidRanking, updatedAt: Date): GuildDocument {
  const { guild } = entry;

  return {
    id: guild.id,
    name: guild.name,
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
