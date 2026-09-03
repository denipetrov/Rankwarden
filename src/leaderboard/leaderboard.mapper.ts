import type { Bracket, Region } from '../blizzard/blizzard.constants.js';
import type { PvpLeaderboard } from '../blizzard/schemas/pvp-leaderboard.schema.js';
import type { BracketStats } from './entities/character.entity.js';

export interface MapLeaderboardContext {
  region: Region;
  bracket: Bracket;
  seasonId: number;
  fetchedAt: Date;
}

/** One character's bracket result, ready to be merged into their document. */
export interface CharacterBracketUpdate {
  seasonId: number;
  region: Region;
  characterId: number;
  characterName: string;
  realmId: number;
  realmSlug: string;
  faction: string | null;
  bracket: Bracket;
  stats: BracketStats;
}

/** Splits a Blizzard leaderboard payload into per-character bracket updates. */
export function toCharacterBracketUpdates(
  leaderboard: PvpLeaderboard,
  { region, bracket, seasonId, fetchedAt }: MapLeaderboardContext,
): CharacterBracketUpdate[] {
  return leaderboard.entries.map((entry) => ({
    seasonId,
    region,
    characterId: entry.character.id,
    characterName: entry.character.name,
    realmId: entry.character.realm.id,
    realmSlug: entry.character.realm.slug,
    faction: entry.faction?.type ?? null,
    bracket,
    stats: {
      rank: entry.rank,
      rating: entry.rating,
      played: entry.season_match_statistics?.played ?? 0,
      won: entry.season_match_statistics?.won ?? 0,
      lost: entry.season_match_statistics?.lost ?? 0,
      fetchedAt,
    },
  }));
}
