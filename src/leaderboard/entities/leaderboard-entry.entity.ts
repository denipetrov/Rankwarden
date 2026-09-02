import type { Bracket, Region } from '../../blizzard/blizzard.constants.js';

/** One ranked character in one bracket, as stored in MongoDB. */
export interface LeaderboardEntryDocument {
  seasonId: number;
  region: Region;
  bracket: Bracket;
  rank: number;
  rating: number;
  characterId: number;
  characterName: string;
  realmId: number;
  realmSlug: string;
  faction: string | null;
  played: number;
  won: number;
  lost: number;
  fetchedAt: Date;
}

export const LEADERBOARD_COLLECTION = 'leaderboard_entries';
