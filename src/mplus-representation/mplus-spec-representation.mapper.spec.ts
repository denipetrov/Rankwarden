import { describe, expect, it } from 'vitest';

import {
  representationsOf,
  toRepresentation,
  type MplusSpecTally,
} from './mplus-spec-representation.mapper.js';

const computedAt = new Date('2026-09-21T00:00:00Z');

function tally(
  region: string,
  specId: number | null,
  role: string,
  count: number,
  classId = 1,
): MplusSpecTally {
  return {
    region,
    classId,
    className: `Class${classId}`,
    specId,
    specName: specId === null ? null : `Spec${specId}`,
    role,
    count,
  };
}

const base = { season: 'season-mn-2', seasonId: 18, source: 'live' as const, computedAt };

describe('toRepresentation', () => {
  const us = [
    tally('us', 250, 'tank', 10),
    tally('us', 65, 'healer', 10),
    tally('us', 62, 'dps', 20),
    tally('us', 71, 'dps', 10),
    // A slot Raider.io reported without a spec: counted, not classified.
    tally('us', null, 'dps', 5),
  ];

  it('counts every slot, and shares only the classified ones', () => {
    const document = toRepresentation({ ...base, region: 'us', runs: 11, tallies: us });

    expect(document.slots).toBe(55);
    expect(document.classified).toBe(50);
    expect(document.roles).toEqual({ tank: 10, healer: 10, dps: 30 });
    expect(document.specs.map((spec) => [spec.specId, spec.count, spec.percent])).toEqual([
      [62, 20, 40],
      [65, 10, 20],
      [71, 10, 20],
      [250, 10, 20],
    ]);
  });

  it('gives each spec its share of its own role, which is how specs compare', () => {
    const document = toRepresentation({ ...base, region: 'us', runs: 11, tallies: us });
    const byId = new Map(document.specs.map((spec) => [spec.specId, spec]));

    // One tank in every run: the only tank is the whole role, though a fifth of
    // all slots.
    expect(byId.get(250)?.percent).toBe(20);
    expect(byId.get(250)?.rolePercent).toBe(100);
    expect(byId.get(62)?.rolePercent).toBe(66.67);
    expect(byId.get(71)?.rolePercent).toBe(33.33);
  });

  it('rounds to two decimals and orders ties the same way every time', () => {
    const document = toRepresentation({
      ...base,
      region: 'us',
      runs: 1,
      tallies: [tally('us', 3, 'dps', 1), tally('us', 2, 'dps', 1), tally('us', 1, 'dps', 1)],
    });

    expect(document.specs.map((spec) => spec.specId)).toEqual([1, 2, 3]);
    expect(document.specs[0].percent).toBe(33.33);
  });

  it('merges tallies of the same class and spec into one entry', () => {
    const document = toRepresentation({
      ...base,
      region: 'all',
      runs: 2,
      tallies: [tally('us', 62, 'dps', 3), tally('eu', 62, 'dps', 4)],
    });

    expect(document.specs).toHaveLength(1);
    expect(document.specs[0].count).toBe(7);
  });
});

describe('representationsOf', () => {
  it('writes one document per region with runs, then one for all regions', () => {
    const documents = representationsOf({
      ...base,
      runsByRegion: new Map([
        ['us', 2],
        ['eu', 1],
      ]),
      tallies: [tally('us', 62, 'dps', 6), tally('eu', 62, 'dps', 2), tally('eu', 71, 'dps', 2)],
    });

    expect(documents.map((document) => [document.region, document.runs, document.slots])).toEqual([
      ['eu', 1, 4],
      ['us', 2, 6],
      ['all', 3, 10],
    ]);
    expect(documents.at(-1)?.specs.map((spec) => [spec.specId, spec.percent])).toEqual([
      [62, 80],
      [71, 20],
    ]);
  });

  it('writes nothing for a season with no runs, rather than an empty document', () => {
    expect(representationsOf({ ...base, runsByRegion: new Map(), tallies: [] })).toEqual([]);
  });
});
