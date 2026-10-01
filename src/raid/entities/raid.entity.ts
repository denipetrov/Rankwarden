import type { RaiderIoRegion } from '../../raiderio/raiderio.constants.js';

/** A boss of a raid, in the order Raider.io lists them. */
export interface RaidEncounter {
  id: number;
  slug: string;
  name: string;
}

/**
 * One raid, as catalogued from Raider.io's `/raiding/static-data`.
 *
 * One document per raid, keyed by Raider.io's raid `id`, which is unique
 * across every expansion. A re-release — Fated in Shadowlands, Awakened in
 * Dragonflight — is a raid of its own upstream, with its own id (the
 * original's plus 100,000,000), slug and dates, and so a document of its own
 * here: it had its own progression race, and folding it into the original
 * would lose that.
 *
 * `slug` is what the raiding endpoints take as `raid=`, which is what the
 * catalogue exists to supply.
 */
export interface RaidDocument {
  id: number;
  slug: string;
  name: string;
  shortName: string | null;
  /** Absent upstream on every raid before Shadowlands. */
  icon: string | null;
  /** The `expansion_id` whose static data listed the raid (6 is Legion). */
  expansionId: number;
  /**
   * When the raid opened and closed, per region. A raid still open carries
   * Raider.io's placeholder end, `2030-01-01`, until it is replaced by the real
   * date — the same convention a running Mythic+ season follows.
   */
  starts: Partial<Record<RaiderIoRegion, Date>>;
  ends: Partial<Record<RaiderIoRegion, Date>>;
  /** Embedded: at most a dozen, never read without their raid. */
  encounters: RaidEncounter[];
  /** When a catalogue walk last listed the raid. */
  catalogueUpdatedAt: Date;
  /**
   * Set when a complete walk no longer lists the raid, cleared if a later one
   * does. Such a raid is never stamped again, so it is left out of the
   * catalogue's freshness; the document itself is kept.
   */
  unlistedAt?: Date;
}

export const RAIDS_COLLECTION = 'raids';
