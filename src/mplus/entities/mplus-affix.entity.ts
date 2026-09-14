/**
 * One weekly affix, stored once and referenced by id from every run.
 *
 * Not a hardcoded table. The affix pool changes between seasons and Blizzard
 * has renamed and reworded affixes mid-expansion, so the names and descriptions
 * are learned from the payloads that carry them and upserted as they are seen —
 * the same approach `season-rewards.ts` takes to specialisations, and for the
 * same reason: a new affix needs no code change.
 *
 * The point of the collection is that a run stores `affixIds: [9, 10, 147]`
 * instead of three names and three ~120-character descriptions. Across roughly
 * 100,000 runs per sweep that is about 36MB of duplicated prose not written.
 */
export interface MplusAffixDocument {
  id: number;
  name: string;
  slug: string | null;
  description: string | null;
  icon: string | null;
  updatedAt: Date;
}

export const MPLUS_AFFIXES_COLLECTION = 'mplus_affixes';
