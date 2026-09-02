import type { Bracket, Region } from '../blizzard/blizzard.constants.js';
import type { PvpLeaderboard } from '../blizzard/schemas/pvp-leaderboard.schema.js';
import type { LeaderboardEntryDocument } from './entities/leaderboard-entry.entity.js';

export interface MapLeaderboardContext {
  region: Region;
  bracket: Bracket;
  seasonId: number;
  fetchedAt: Date;
}

/** Flattens a Blizzard leaderboard payload into storable documents. */
export function toLeaderboardDocuments(
  leaderboard: PvpLeaderboard,
  { region, bracket, seasonId, fetchedAt }: MapLeaderboardContext,
): LeaderboardEntryDocument[] {
  return leaderboard.entries.map((entry) => ({
    seasonId,
    region,
    bracket,
    rank: entry.rank,
    rating: entry.rating,
    characterId: entry.character.id,
    characterName: entry.character.name,
    realmId: entry.character.realm.id,
    realmSlug: entry.character.realm.slug,
    faction: entry.faction?.type ?? null,
    played: entry.season_match_statistics?.played ?? 0,
    won: entry.season_match_statistics?.won ?? 0,
    lost: entry.season_match_statistics?.lost ?? 0,
    fetchedAt,
  }));
}
