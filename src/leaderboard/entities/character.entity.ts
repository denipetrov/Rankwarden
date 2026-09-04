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
  /** Full per-bracket payload. Never indexed — read, not searched. */
  brackets: Partial<Record<Bracket, BracketStats>>;
  /**
   * Rating per bracket, mirrored out of `brackets` purely so a single compound
   * wildcard index can serve ordered ladder queries for every bracket at once.
   * One index instead of one per bracket, which would blow MongoDB's cap of 64.
   */
  ratings: Partial<Record<Bracket, number>>;
  updatedAt: Date;
  profile?: CharacterProfile;
  profileStatus?: ProfileStatus;
  /**
   * The two profile endpoints age at different rates, so each carries its own
   * timestamp: race, class, realm and title rarely change, whereas spec and
   * hero talents move whenever a player respecs. Absent means never fetched.
   */
  profileFetchedAt?: Date;
  specsFetchedAt?: Date;
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
  /**
   * The active loadout for each spec the character has built, so a UI filtering
   * by spec can show the matching build. The one being played is the entry whose
   * `spec.id` matches `spec` above. Empty when nothing is linkable.
   */
  talentLoadouts: SpecLoadout[];
  level: number;
  gender: string | null;
  guild: NamedRef | null;
  /** Realm display name, e.g. "Demon Soul" — the sweep only knows the slug. */
  realmName: string | null;
  /** Equipped title as Blizzard renders it, e.g. "Galactic Gladiator {name}". */
  title: string | null;
  averageItemLevel: number | null;
  equippedItemLevel: number | null;
  lastLoginAt: Date | null;
}

/** One specialisation's active build, kept paired with the spec it belongs to. */
export interface SpecLoadout {
  spec: NamedRef;
  /** Null when Blizzard reports the loadout without an importable code. */
  talentLoadoutCode: string | null;
  /**
   * The hero tree of *this* spec's build. Distinct from `profile.heroTalentTree`,
   * which is only the active spec's — attributing that one to another spec's
   * ladder yields combinations the game does not permit.
   */
  heroTalentTree: NamedRef | null;
}

/** Why a character has no profile, so the worker can skip known-gone ones. */
export type ProfileStatus = 'ok' | 'missing';

export const CHARACTERS_COLLECTION = 'characters';
