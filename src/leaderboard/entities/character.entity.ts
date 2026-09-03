import type { Bracket, Region } from '../../blizzard/blizzard.constants.js';

/** A character's standing in one bracket. */
export interface BracketStats {
  rank: number;
  rating: number;
  played: number;
  won: number;
  lost: number;
  fetchedAt: Date;
}

/**
 * One document per character per season+region, with every bracket they appear
 * in nested under `brackets`. Identity (name, realm, faction) is stored once
 * instead of being repeated for each ladder they show up on.
 */
export interface CharacterDocument {
  seasonId: number;
  region: Region;
  characterId: number;
  characterName: string;
  realmId: number;
  realmSlug: string;
  faction: string | null;
  brackets: Partial<Record<Bracket, BracketStats>>;
  updatedAt: Date;
}

export const CHARACTERS_COLLECTION = 'characters';
