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
  profile?: CharacterProfile;
  profileStatus?: ProfileStatus;
  /** Drives staleness selection; absent means never enriched. */
  profileFetchedAt?: Date;
}

/** Blizzard's { id, name } reference, flattened to what we store. */
export interface NamedRef {
  id: number;
  name: string;
}

/**
 * Character detail from the profile endpoints. Filled in by the enrichment
 * worker rather than the leaderboard sweep, because it costs two API requests
 * per character and the hourly quota does not allow refetching every sweep.
 */
export interface CharacterProfile {
  race: NamedRef;
  class: NamedRef;
  spec: NamedRef | null;
  /** Null for characters below the hero-talent level, or with none chosen. */
  heroTalentTree: NamedRef | null;
  level: number;
  gender: string | null;
  guild: NamedRef | null;
  averageItemLevel: number | null;
  equippedItemLevel: number | null;
  lastLoginAt: Date | null;
}

/** Why a character has no profile, so the worker can skip known-gone ones. */
export type ProfileStatus = 'ok' | 'missing';

export const CHARACTERS_COLLECTION = 'characters';
