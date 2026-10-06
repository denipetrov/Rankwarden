import type { IndexDescription } from 'mongodb';

/** Indexes on `raids`. */
export const RAIDS_INDEXES: IndexDescription[] = [
  // The identity. Raider.io's raid id is unique across every expansion.
  { key: { id: 1 }, name: 'raid_identity', unique: true },
  // What the raiding endpoints are asked by. Not unique: the id is the
  // identity, and a slug Raider.io ever reused must not fail a whole walk.
  { key: { slug: 1 }, name: 'raid_slug' },
  { key: { expansionId: 1 }, name: 'raid_expansion' },
];

/** Indexes on `guilds`. */
export const GUILDS_INDEXES: IndexDescription[] = [
  // The identity, and what a raid's board points at.
  { key: { id: 1 }, name: 'guild_identity', unique: true },
  { key: { region: 1, 'realm.slug': 1, name: 1 }, name: 'guild_region_realm_name' },
];
