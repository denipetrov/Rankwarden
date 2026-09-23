import { describe, expect, it } from 'vitest';

import { seasonCutoffsSchema } from '../raiderio/schemas/season-cutoffs.schema.js';
import { toSeasonCutoffs } from './mplus-cutoffs.mapper.js';

const fetchedAt = new Date('2026-09-23T00:00:00Z');

/** Trimmed from the live `season-cutoffs` payload for `season-tww-2`/`us`. */
const payload = seasonCutoffsSchema.parse({
  cutoffs: {
    updatedAt: 'Mon Jan 19 2026 22:41:01 GMT+0000 (Coordinated Universal Time)',
    region: { name: 'United States & Oceania', slug: 'us', short_name: 'US' },
    p999: {
      horde: {
        quantile: 0.999,
        quantileMinValue: 3593.17,
        quantilePopulationCount: 542,
        quantilePopulationFraction: 0.0010012802346912196,
        totalPopulationCount: 541307,
      },
      hordeColor: '#e85e7d',
      alliance: {
        quantile: 0.999,
        quantileMinValue: 3820.9,
        quantilePopulationCount: 545,
        quantilePopulationFraction: 0.0010016154495047977,
        totalPopulationCount: 544121,
      },
      all: {
        quantile: 0.999,
        quantileMinValue: 3804.69,
        quantilePopulationCount: 1087,
        quantilePopulationFraction: 0.0010014482766245204,
        totalPopulationCount: 1085428,
      },
    },
    p990: {
      all: {
        quantile: 0.99,
        quantileMinValue: 3425.36,
        quantilePopulationCount: 10855,
        quantilePopulationFraction: 0.010000663332805124,
        totalPopulationCount: 1085428,
      },
    },
    p900: { all: { quantile: 0.9, quantileMinValue: 3024.99 } },
    keystoneMaster: {
      score: 2000,
      horde: { quantile: 0.528, quantileMinValue: 1999.8 },
      alliance: { quantile: 0.503, quantileMinValue: 1996.29 },
      all: { quantile: 0.515, quantileMinValue: 1995.26 },
    },
    keystoneHero: { score: 2500, all: { quantile: 0.658, quantileMinValue: 2499.84 } },
    keystoneConqueror: { score: 1500, all: { quantile: 0.32, quantileMinValue: 1499.24 } },
    keystoneExplorer: { score: 750, all: { quantile: 0.12, quantileMinValue: 748.02 } },
    // Midnight's tier, and one the season did not award: null, not absent.
    keystoneMyth: null,
    keystoneLegend: null,
    graphData: [{ x: 1, y: 2 }],
    allTimed20: 5,
  },
});

describe('toSeasonCutoffs', () => {
  const cutoffs = toSeasonCutoffs(payload.cutoffs, fetchedAt);

  it('keeps the title tiers the season awarded, by their own names', () => {
    expect(Object.keys(cutoffs.keystones)).toEqual([
      'keystoneExplorer',
      'keystoneConqueror',
      'keystoneMaster',
      'keystoneHero',
    ]);
    expect(cutoffs.keystones.keystoneMaster?.score).toBe(2000);
    expect(cutoffs.keystones.keystoneMaster?.all?.minScore).toBe(1995.26);
  });

  it('leaves out a tier the season did not award, rather than storing null', () => {
    // Absent means "no such title that season", which is what a reader needs;
    // a null entry would have to be told apart from a tier not yet read.
    expect(cutoffs.keystones).not.toHaveProperty('keystoneMyth');
    expect(cutoffs.keystones).not.toHaveProperty('keystoneLegend');
  });

  it('keeps the top 0.1% and 1% cutoffs, and nothing else from the payload', () => {
    expect(Object.keys(cutoffs.quantiles)).toEqual(['p999', 'p990']);
    expect(cutoffs.quantiles.p999?.score, 'a percentile has no fixed score').toBeNull();
  });

  it('renames the population fields to what they mean', () => {
    expect(cutoffs.quantiles.p999?.horde).toEqual({
      quantile: 0.999,
      minScore: 3593.17,
      populationCount: 542,
      populationFraction: 0.0010012802346912196,
      totalPopulation: 541307,
    });
  });

  it('keeps both factions apart, and both together', () => {
    const p999 = cutoffs.quantiles.p999!;

    expect([p999.horde?.minScore, p999.alliance?.minScore, p999.all?.minScore]).toEqual([
      3593.17, 3820.9, 3804.69,
    ]);
  });

  it("reads Raider.io's own timestamp", () => {
    expect(cutoffs.updatedAt).toEqual(new Date('2026-01-19T22:41:01Z'));
    expect(cutoffs.status).toBe('ok');
    expect(cutoffs.attempts).toBe(0);
    expect(cutoffs.fetchedAt).toBe(fetchedAt);
  });

  it('records no timestamp rather than an invalid date', () => {
    const undated = toSeasonCutoffs({ ...payload.cutoffs, updatedAt: 'not a date' }, fetchedAt);

    expect(undated.updatedAt).toBeNull();
  });

  it('drops a tier whose factions are all empty', () => {
    // The same "no such title" in a different shape: an entry with a score and
    // no faction at all.
    const empty = toSeasonCutoffs(
      { ...payload.cutoffs, keystoneHero: { score: 2500, all: null, horde: null, alliance: null } },
      fetchedAt,
    );

    expect(empty.keystones).not.toHaveProperty('keystoneHero');
  });

  it('keeps a faction reported without figures as null', () => {
    const partial = toSeasonCutoffs(
      { ...payload.cutoffs, p990: { all: { quantile: 0.99, quantileMinValue: 3425.36 } } },
      fetchedAt,
    );

    expect(partial.quantiles.p990?.horde).toBeNull();
    expect(partial.quantiles.p990?.all?.populationCount).toBeNull();
  });
});
