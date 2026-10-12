import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TtlCache } from './ttl-cache.js';

describe('TtlCache', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: new Date('2026-10-01T00:00:00.000Z') });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns what was stored until the time to live has passed', () => {
    const cache = new TtlCache<string, number>(1_000);
    cache.set('a', 1);

    vi.advanceTimersByTime(999);
    expect(cache.get('a')).toBe(1);

    vi.advanceTimersByTime(1);
    expect(cache.get('a')).toBeUndefined();
  });

  it('drops an expired entry rather than keeping it for good', () => {
    const cache = new TtlCache<string, number>(1_000);
    cache.set('a', 1);

    vi.advanceTimersByTime(1_000);
    cache.get('a');

    expect(cache.size).toBe(0);
  });

  it('misses on a key that was never stored', () => {
    expect(new TtlCache<string, number>(1_000).get('a')).toBeUndefined();
  });

  it('restarts the clock when a key is stored again', () => {
    const cache = new TtlCache<string, number>(1_000);
    cache.set('a', 1);
    vi.advanceTimersByTime(900);
    cache.set('a', 2);
    vi.advanceTimersByTime(900);

    expect(cache.get('a')).toBe(2);
  });

  it('stores nothing when the time to live is zero', () => {
    const cache = new TtlCache<string, number>(0);
    cache.set('a', 1);

    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(0);
  });
});
