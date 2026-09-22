import { describe, expect, it } from 'vitest';

import {
  representationsOf,
  toRepresentation,
  type MplusRunCount,
  type MplusSpecTally,
} from './mplus-spec-representation.mapper.js';

const computedAt = new Date('2026-09-22T00:00:00Z');

const floodgate = {
  id: 12_773,
  name: 'Operation: Floodgate',
  slug: 'floodgate',
  shortName: 'FLOOD',
};
const dawnbreaker = { id: 12_662, name: 'The Dawnbreaker', slug: 'dawnbreaker', shortName: 'DAWN' };

function tally(
  region: string,
  specId: number | null,
  role: string,
  count: number,
  dungeonId = floodgate.id,
  classId = 1,
): MplusSpecTally {
  return {
    region,
    dungeonId,
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
  const everyDungeon = { ...base, region: 'us' as const, dungeon: null, runs: 11 };

  it('counts every slot, and shares only the classified ones', () => {
    const document = toRepresentation({ ...everyDungeon, tallies: us });

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
    const document = toRepresentation({ ...everyDungeon, tallies: us });
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
      ...everyDungeon,
      runs: 1,
      tallies: [tally('us', 3, 'dps', 1), tally('us', 2, 'dps', 1), tally('us', 1, 'dps', 1)],
    });

    expect(document.specs.map((spec) => spec.specId)).toEqual([1, 2, 3]);
    expect(document.specs[0].percent).toBe(33.33);
  });

  it('merges tallies of the same class and spec into one entry', () => {
    const document = toRepresentation({
      ...everyDungeon,
      region: 'all',
      runs: 2,
      tallies: [
        tally('us', 62, 'dps', 3),
        tally('eu', 62, 'dps', 4),
        tally('eu', 62, 'dps', 1, dawnbreaker.id),
      ],
    });

    expect(document.specs).toHaveLength(1);
    expect(document.specs[0].count).toBe(8);
  });

  it('names the dungeon it covers, or none when it covers them all', () => {
    const one = toRepresentation({ ...everyDungeon, dungeon: floodgate, tallies: us });
    const all = toRepresentation({ ...everyDungeon, tallies: us });

    expect([one.dungeonId, one.dungeon?.name]).toEqual([floodgate.id, 'Operation: Floodgate']);
    expect([all.dungeonId, all.dungeon]).toEqual([null, null]);
  });
});

describe('representationsOf', () => {
  const runCounts: MplusRunCount[] = [
    { region: 'us', dungeon: floodgate, runs: 2 },
    { region: 'eu', dungeon: floodgate, runs: 1 },
    { region: 'eu', dungeon: dawnbreaker, runs: 1 },
  ];
  const tallies = [
    tally('us', 62, 'dps', 6),
    tally('eu', 62, 'dps', 2),
    tally('eu', 71, 'dps', 2, dawnbreaker.id),
  ];

  it('writes, per region and then for all, every dungeon together and then each dungeon', () => {
    const documents = representationsOf({ ...base, runCounts, tallies });

    expect(
      documents.map((document) => [
        document.region,
        document.dungeonId,
        document.runs,
        document.slots,
      ]),
    ).toEqual([
      ['eu', null, 2, 4],
      ['eu', dawnbreaker.id, 1, 2],
      ['eu', floodgate.id, 1, 2],
      ['us', null, 2, 6],
      ['us', floodgate.id, 2, 6],
      ['all', null, 4, 10],
      ['all', dawnbreaker.id, 1, 2],
      ['all', floodgate.id, 3, 8],
    ]);
  });

  it('shares each document out of its own dungeon only', () => {
    const documents = representationsOf({ ...base, runCounts, tallies });
    const find = (region: string, dungeonId: number | null) =>
      documents.find((document) => document.region === region && document.dungeonId === dungeonId)!;

    expect(find('all', null).specs.map((spec) => [spec.specId, spec.percent])).toEqual([
      [62, 80],
      [71, 20],
    ]);
    // Only spec 71 ran Dawnbreaker, so it is the whole of that dungeon.
    expect(find('all', dawnbreaker.id).specs.map((spec) => [spec.specId, spec.percent])).toEqual([
      [71, 100],
    ]);
  });

  it('writes no document for a dungeon a region never ran, rather than an empty one', () => {
    const documents = representationsOf({ ...base, runCounts, tallies });

    expect(
      documents.find(
        (document) => document.region === 'us' && document.dungeonId === dawnbreaker.id,
      ),
    ).toBeUndefined();
  });

  it('writes nothing for a season with no runs', () => {
    expect(representationsOf({ ...base, runCounts: [], tallies: [] })).toEqual([]);
  });
});
