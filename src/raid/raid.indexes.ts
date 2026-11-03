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

/** Indexes on `bosses`. */
export const BOSSES_INDEXES: IndexDescription[] = [
  // The identity: the encounter id, unique across every raid.
  { key: { id: 1 }, name: 'boss_identity', unique: true },
  // A raid's bosses, and a boss by name within its raid. Not unique by slug
  // alone: a re-release's boss can share the original's.
  { key: { raidId: 1, slug: 1 }, name: 'boss_raid_slug' },
  // The same by the raid's slug, which is what a reader searches with:
  // { raidSlug: 'the-venomous-abyss' }, or with a boss slug for one boss.
  { key: { raidSlug: 1, slug: 1 }, name: 'boss_raid_slug_name' },
];

/** Indexes on `guilds`. */
export const GUILDS_INDEXES: IndexDescription[] = [
  // The identity, and what a raid's board points at.
  { key: { id: 1 }, name: 'guild_identity', unique: true },
  { key: { region: 1, 'realm.slug': 1, name: 1 }, name: 'guild_region_realm_name' },
  // Name search: an anchored prefix on the folded name, answered as an index
  // range — find({ searchName: { $regex: '^biba' } }).limit(100).
  { key: { searchName: 1 }, name: 'guild_search' },
];
