import { describe, expect, it } from 'vitest';

import { startOfUtcDay, toSlug } from './spec-representation.entity.js';

describe('toSlug', () => {
  it('matches the slugs Blizzard uses in bracket names', () => {
    // These have to line up, or shuffle and 3v3 would report the same spec
    // under two different keys.
    expect(toSlug('Death Knight')).toBe('deathknight');
    expect(toSlug('Demon Hunter')).toBe('demonhunter');
    expect(toSlug('Beast Mastery')).toBe('beastmastery');
    expect(toSlug('Fire')).toBe('fire');
  });
});

describe('startOfUtcDay', () => {
  it('truncates to UTC midnight', () => {
    expect(startOfUtcDay(new Date('2026-09-04T23:45:12.500Z')).toISOString()).toBe(
      '2026-09-04T00:00:00.000Z',
    );
  });

  it('uses UTC rather than local time, so a day is the same everywhere', () => {
    // 00:30 UTC is still the previous day in the Americas; the snapshot must
    // not shift depending on where the process runs.
    expect(startOfUtcDay(new Date('2026-09-05T00:30:00.000Z')).toISOString()).toBe(
      '2026-09-05T00:00:00.000Z',
    );
  });

  it('is idempotent', () => {
    const once = startOfUtcDay(new Date('2026-09-04T13:00:00.000Z'));
    expect(startOfUtcDay(once).getTime()).toBe(once.getTime());
  });
});
