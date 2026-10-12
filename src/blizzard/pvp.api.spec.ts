import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { validateEnv, type Env } from '../config/env.schema.js';
import { PvpApi } from './pvp.api.js';

const HALF_DAY_MS = 12 * 60 * 60 * 1000;
const NOW = new Date('2026-10-01T00:00:00.000Z');

const base = {
  BLIZZARD_CLIENT_ID: 'id',
  BLIZZARD_CLIENT_SECRET: 'secret',
  MONGODB_URI: 'mongodb://localhost:27017',
};

const bracketIndex = (...names: string[]) => ({
  leaderboards: names.map((name) => ({ name })),
});

const seasonRecord = (id: number, endsAt?: Date) => ({
  id,
  season_start_timestamp: new Date('2026-03-17T15:00:00.000Z').getTime(),
  ...(endsAt ? { season_end_timestamp: endsAt.getTime() } : {}),
});

describe('PvpApi reference cache', () => {
  const get = vi.fn();

  function build(overrides: Record<string, string> = {}): PvpApi {
    const env = validateEnv({ ...base, ...overrides });

    return new PvpApi({ get } as never, { get: (key: keyof Env) => env[key] } as never);
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    get.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('asks for a bracket list once and reuses the answer', async () => {
    get.mockResolvedValue(bracketIndex('3v3', 'rbg'));
    const api = build();

    await expect(api.getBrackets('us', 42)).resolves.toEqual(['3v3', 'rbg']);
    await expect(api.getBrackets('us', 42)).resolves.toEqual(['3v3', 'rbg']);

    expect(get).toHaveBeenCalledTimes(1);
  });

  it('keeps a bracket list per region and per season', async () => {
    get.mockResolvedValue(bracketIndex('3v3'));
    const api = build();

    await api.getBrackets('us', 42);
    await api.getBrackets('eu', 42);
    await api.getBrackets('us', 43);

    expect(get).toHaveBeenCalledTimes(3);
  });

  it('asks again once half a day has passed, and picks up a new bracket', async () => {
    get.mockResolvedValueOnce(bracketIndex('3v3'));
    get.mockResolvedValueOnce(bracketIndex('3v3', 'shuffle-new-spec'));
    const api = build();

    await api.getBrackets('us', 42);
    vi.advanceTimersByTime(HALF_DAY_MS - 1);
    await expect(api.getBrackets('us', 42)).resolves.toEqual(['3v3']);

    vi.advanceTimersByTime(1);
    await expect(api.getBrackets('us', 42)).resolves.toEqual(['3v3', 'shuffle-new-spec']);
  });

  it('does not keep an empty bracket list', async () => {
    // A season whose ladders are not published yet must not stay empty.
    get.mockResolvedValueOnce(bracketIndex());
    get.mockResolvedValueOnce(bracketIndex('3v3'));
    const api = build();

    await expect(api.getBrackets('us', 43)).resolves.toEqual([]);
    await expect(api.getBrackets('us', 43)).resolves.toEqual(['3v3']);
  });

  it('does not keep a failure', async () => {
    get.mockRejectedValueOnce(new Error('503'));
    get.mockResolvedValueOnce(bracketIndex('3v3'));
    const api = build();

    await expect(api.getBrackets('us', 42)).rejects.toThrow('503');
    await expect(api.getBrackets('us', 42)).resolves.toEqual(['3v3']);
  });

  it('hands each caller its own copy of the list', async () => {
    get.mockResolvedValue(bracketIndex('3v3', 'rbg'));
    const api = build();

    (await api.getBrackets('us', 42)).length = 0;

    await expect(api.getBrackets('us', 42)).resolves.toEqual(['3v3', 'rbg']);
  });

  it('reads a running season fresh every time, so its end date is seen at once', async () => {
    const endsAt = new Date(NOW.getTime() - 60_000);
    get.mockResolvedValueOnce(seasonRecord(42));
    get.mockResolvedValueOnce(seasonRecord(42, endsAt));
    const api = build();

    await expect(api.getSeason('us', 42)).resolves.toMatchObject({ endsAt: null });
    await expect(api.getSeason('us', 42)).resolves.toMatchObject({ endsAt });
  });

  it('reuses the record of a season that has finished', async () => {
    get.mockResolvedValue(seasonRecord(41, new Date('2026-08-11T05:00:00.000Z')));
    const api = build();

    const first = await api.getSeason('us', 41);
    const second = await api.getSeason('us', 41);

    expect(second).toEqual(first);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('does not reuse a season whose end date is still ahead', async () => {
    // Announced, not over: the date could still move.
    get.mockResolvedValue(seasonRecord(42, new Date(NOW.getTime() + 60_000)));
    const api = build();

    await api.getSeason('us', 42);
    await api.getSeason('us', 42);

    expect(get).toHaveBeenCalledTimes(2);
  });

  it('never reuses the season index, which is how a rollover is noticed', async () => {
    get.mockResolvedValueOnce({ seasons: [{ id: 42 }], current_season: { id: 42 } });
    get.mockResolvedValueOnce({ seasons: [{ id: 42 }, { id: 43 }], current_season: { id: 43 } });
    const api = build();

    await expect(api.getSeasonIndex('us')).resolves.toMatchObject({ current_season: { id: 42 } });
    await expect(api.getSeasonIndex('us')).resolves.toMatchObject({ current_season: { id: 43 } });
  });

  it('asks every time when the cache is switched off', async () => {
    get.mockResolvedValue(bracketIndex('3v3'));
    const api = build({ BLIZZARD_REFERENCE_CACHE_TTL_MS: '0' });

    await api.getBrackets('us', 42);
    await api.getBrackets('us', 42);

    expect(get).toHaveBeenCalledTimes(2);
  });
});
