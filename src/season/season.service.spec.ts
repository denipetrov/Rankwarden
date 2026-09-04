import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PvpApi } from '../blizzard/pvp.api.js';
import { SeasonService } from './season.service.js';

describe('SeasonService', () => {
  const getSeasonIndex = vi.fn();
  const getSeason = vi.fn();
  let service: SeasonService;

  beforeEach(async () => {
    getSeasonIndex.mockReset();
    getSeason.mockReset();
    getSeason.mockResolvedValue({
      id: 42,
      startsAt: new Date('2026-08-18T15:00:00.000Z'),
      endsAt: null,
    });

    const moduleRef = await Test.createTestingModule({
      providers: [SeasonService, { provide: PvpApi, useValue: { getSeasonIndex, getSeason } }],
    }).compile();

    service = moduleRef.get(SeasonService);
  });

  it('caches the current season per region', async () => {
    getSeasonIndex.mockResolvedValue({ seasons: [], current_season: { id: 42 } });

    await expect(service.refresh('us')).resolves.toBe(42);
    expect(service.getCurrentSeason('us')).toBe(42);
    expect(service.getCurrentSeason('eu')).toBeUndefined();
  });

  it('replaces the cached season when Blizzard rolls a new one', async () => {
    getSeasonIndex.mockResolvedValueOnce({ seasons: [], current_season: { id: 42 } });
    getSeasonIndex.mockResolvedValueOnce({ seasons: [], current_season: { id: 43 } });
    getSeason.mockResolvedValueOnce({
      id: 42,
      startsAt: new Date('2026-05-01T00:00:00.000Z'),
      endsAt: null,
    });
    getSeason.mockResolvedValueOnce({
      id: 43,
      startsAt: new Date('2026-08-18T15:00:00.000Z'),
      endsAt: null,
    });

    await service.refresh('eu');
    await service.refresh('eu');

    expect(service.getCurrentSeason('eu')).toBe(43);
    expect(service.getSeasonStart('eu')?.toISOString()).toBe('2026-08-18T15:00:00.000Z');
  });

  it('does not report an unknown region as ended', async () => {
    // Optional chaining here would make `undefined !== null` read as "ended".
    expect(service.hasEnded('kr')).toBe(false);
    expect(service.getSeasonEnd('kr')).toBeUndefined();
  });

  it('keeps re-reading a running season, because its end date appears there', async () => {
    getSeasonIndex.mockResolvedValue({ seasons: [], current_season: { id: 42 } });

    await service.refresh('eu');
    await service.refresh('eu');
    await service.refresh('eu');

    // No end date yet, so the record can still change and must be re-read.
    expect(getSeason).toHaveBeenCalledTimes(3);
    expect(service.hasEnded('eu')).toBe(false);
  });

  it('picks up the end date when it appears, then stops re-reading', async () => {
    getSeasonIndex.mockResolvedValue({ seasons: [], current_season: { id: 42 } });
    getSeason.mockResolvedValueOnce({
      id: 42,
      startsAt: new Date('2026-08-18T15:00:00.000Z'),
      endsAt: null,
    });
    getSeason.mockResolvedValue({
      id: 42,
      startsAt: new Date('2026-08-18T15:00:00.000Z'),
      endsAt: new Date('2027-01-12T06:00:00.000Z'),
    });

    await service.refresh('eu');
    expect(service.hasEnded('eu')).toBe(false);

    await service.refresh('eu');
    expect(service.hasEnded('eu')).toBe(true);
    expect(service.getSeasonEnd('eu')?.toISOString()).toBe('2027-01-12T06:00:00.000Z');

    // Settled now: nothing about a finished season can change again.
    await service.refresh('eu');
    expect(getSeason).toHaveBeenCalledTimes(2);
  });

  it('records the last completed season when Blizzard publishes one', async () => {
    getSeasonIndex.mockResolvedValue({
      seasons: [],
      current_season: { id: 42 },
      last_completed_season: { id: 41 },
    });

    await service.refresh('us');

    expect(service.describe().us).toMatchObject({ id: 42, lastCompleted: 41 });
  });
});
