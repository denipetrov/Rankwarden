import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PvpApi } from '../blizzard/pvp.api.js';
import { SeasonService } from './season.service.js';

describe('SeasonService', () => {
  const getSeasonIndex = vi.fn();
  let service: SeasonService;

  beforeEach(async () => {
    getSeasonIndex.mockReset();

    const moduleRef = await Test.createTestingModule({
      providers: [SeasonService, { provide: PvpApi, useValue: { getSeasonIndex } }],
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

    await service.refresh('eu');
    await service.refresh('eu');

    expect(service.snapshot()).toEqual({ eu: 43 });
  });
});
