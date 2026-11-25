import type { IndexDescription } from 'mongodb';

/** Indexes on `hidden_entries`. */
export const HIDDEN_ENTRIES_INDEXES: IndexDescription[] = [
  { key: { kind: 1, key: 1 }, name: 'hidden_identity', unique: true },
];

/**
 * The index on `hidden` that `characters`, `mplus_characters` and `guilds`
 * each carry, so a reader can list the hidden ones, and so the boot-time
 * default for documents written before the field existed reads an index range
 * rather than the whole collection.
 */
export function hiddenIndex(name: string): IndexDescription {
  return { key: { hidden: 1 }, name };
}
