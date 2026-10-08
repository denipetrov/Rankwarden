import { describe, expect, it } from 'vitest';

import { ALL_COLLECTIONS } from '../collections.js';
import { DATABASE_SCHEMA } from './schema.definition.js';

describe('DATABASE_SCHEMA', () => {
  it('declares every collection the service uses, and only those', () => {
    // A collection that is used but not declared here still gets created, by
    // its first insert — with none of its indexes, and so with no uniqueness to
    // stop duplicates. Nothing fails; the data just quietly goes wrong.
    const declared = DATABASE_SCHEMA.map((definition) => definition.collection).sort();

    expect(declared).toEqual([...ALL_COLLECTIONS].sort());
  });

  it('declares each collection once', () => {
    const names = DATABASE_SCHEMA.map((definition) => definition.collection);

    expect(new Set(names).size).toBe(names.length);
  });

  it('names every index, uniquely within its collection', () => {
    // Verification matches stored indexes to declared ones by name, so an
    // unnamed index could never be checked and a duplicate name would shadow one.
    for (const { collection, indexes } of DATABASE_SCHEMA) {
      const names = indexes.map((index) => index.name);

      expect(names.every(Boolean), `${collection}: every index needs a name`).toBe(true);
      expect(new Set(names).size, `${collection}: duplicate index name`).toBe(names.length);
    }
  });

  it('never retires an index it also declares', () => {
    // Applying would build it and then drop it, on every single release.
    for (const { collection, indexes, retiredIndexes, retiredIndexPattern } of DATABASE_SCHEMA) {
      for (const { name } of indexes) {
        expect(retiredIndexes?.has(name ?? '') ?? false, `${collection}.${name}`).toBe(false);
        expect(retiredIndexPattern?.test(name ?? '') ?? false, `${collection}.${name}`).toBe(false);
      }
    }
  });
});
