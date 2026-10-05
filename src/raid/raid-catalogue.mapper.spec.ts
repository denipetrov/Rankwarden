import { describe, expect, it } from 'vitest';

import { raidStaticDataSchema } from '../raiderio/schemas/raid-static-data.schema.js';
import { toRaidDocument } from './raid-catalogue.mapper.js';

/** Trimmed from real `/raiding/static-data` answers (checked live, 2026-10-01). */
const MANAFORGE = {
  id: 16178,
  slug: 'manaforge-omega',
  name: 'Manaforge Omega',
  short_name: 'MFO',
  icon: 'inv_112_achievement_raid_manaforgeomega',
  starts: { us: '2025-08-12T15:00:00Z', eu: '2025-08-13T04:00:00Z', cn: '2025-08-13T23:00:00Z' },
  ends: { us: '2026-03-02T22:00:00Z', eu: '2026-03-02T22:00:00Z', cn: '2026-03-02T22:00:00Z' },
  encounters: [
    { id: 197124, slug: 'plexus-sentinel', name: 'Plexus Sentinel' },
    { id: 197125, slug: 'loomithar', name: "Loom'ithar" },
  ],
};

/** Legion: no `icon` at all. */
const NIGHTHOLD = {
  id: 8025,
  slug: 'the-nighthold',
  name: 'The Nighthold',
  short_name: 'NH',
  starts: { us: '2017-01-17T15:00:00Z' },
  ends: { us: '2017-06-13T15:00:00Z' },
  encounters: [{ id: 1849, slug: 'skorpyron', name: 'Skorpyron' }],
};

describe('raidStaticDataSchema', () => {
  it('parses a raid with every field', () => {
    const { raids } = raidStaticDataSchema.parse({ raids: [MANAFORGE] });

    expect(raids[0]).toMatchObject({ id: 16178, slug: 'manaforge-omega', short_name: 'MFO' });
    expect(raids[0].encounters).toHaveLength(2);
  });

  it('parses a raid with no icon, as every raid before Shadowlands is listed', () => {
    const { raids } = raidStaticDataSchema.parse({ raids: [NIGHTHOLD] });

    expect(raids[0].icon).toBeUndefined();
  });

  it('ignores fields it does not know, and tolerates a raid with no encounters or dates', () => {
    const { raids } = raidStaticDataSchema.parse({
      raids: [{ id: 1, slug: 'bare', name: 'Bare', somethingNew: { nested: true } }],
    });

    expect(raids[0]).toEqual({ id: 1, slug: 'bare', name: 'Bare' });
  });

  it('refuses a raid with no identity, and a body that is not a list of raids', () => {
    expect(() => raidStaticDataSchema.parse({ raids: [{ slug: 'x', name: 'X' }] })).toThrow();
    expect(() => raidStaticDataSchema.parse({ raids: 'nope' })).toThrow();
    expect(() => raidStaticDataSchema.parse({ statusCode: 400 })).toThrow();
  });
});

describe('toRaidDocument', () => {
  const at = new Date('2026-10-01T12:00:00Z');

  it('stores a raid under its expansion, with dates as dates and encounters in order', () => {
    const [raid] = raidStaticDataSchema.parse({ raids: [MANAFORGE] }).raids;

    expect(toRaidDocument(raid, 10, at)).toEqual({
      id: 16178,
      slug: 'manaforge-omega',
      name: 'Manaforge Omega',
      shortName: 'MFO',
      icon: 'inv_112_achievement_raid_manaforgeomega',
      expansionId: 10,
      starts: {
        us: new Date('2025-08-12T15:00:00Z'),
        eu: new Date('2025-08-13T04:00:00Z'),
        cn: new Date('2025-08-13T23:00:00Z'),
      },
      ends: {
        us: new Date('2026-03-02T22:00:00Z'),
        eu: new Date('2026-03-02T22:00:00Z'),
        cn: new Date('2026-03-02T22:00:00Z'),
      },
      encounters: [
        { id: 197124, slug: 'plexus-sentinel', name: 'Plexus Sentinel' },
        { id: 197125, slug: 'loomithar', name: "Loom'ithar" },
      ],
      catalogueUpdatedAt: at,
    });
  });

  it('stores a missing icon as null, so a reader never tells absent from unread', () => {
    const [raid] = raidStaticDataSchema.parse({ raids: [NIGHTHOLD] }).raids;

    expect(toRaidDocument(raid, 6, at).icon).toBeNull();
  });

  it('drops a date that does not parse, and leaves a raid with nothing empty rather than broken', () => {
    const [raid] = raidStaticDataSchema.parse({
      raids: [
        { id: 1, slug: 'bare', name: 'Bare', starts: { us: 'soon', eu: '2026-01-01T00:00:00Z' } },
      ],
    }).raids;

    expect(toRaidDocument(raid, 11, at)).toMatchObject({
      shortName: null,
      icon: null,
      starts: { eu: new Date('2026-01-01T00:00:00Z') },
      ends: {},
      encounters: [],
    });
  });
});
