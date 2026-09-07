import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PvpApi } from '../blizzard/pvp.api.js';
import { SeasonEvents } from './season-events.service.js';
import { SeasonStateRepository } from './season-state.repository.js';
import { SeasonService } from './season.service.js';
import type { SeasonTransitionEvent } from './season-events.service.js';

describe('SeasonService', () => {
  const getSeasonIndex = vi.fn();
  const getSeason = vi.fn();
  const loadAll = vi.fn();
  const save = vi.fn();
  let service: SeasonService;
  let events: SeasonTransitionEvent[];

  beforeEach(async () => {
    getSeasonIndex.mockReset();
    getSeason.mockReset();
    loadAll.mockReset();
    save.mockReset();
    // Nothing persisted unless a test says otherwise.
    loadAll.mockResolvedValue([]);
    save.mockResolvedValue(undefined);
    getSeason.mockResolvedValue({
      id: 42,
      startsAt: new Date('2026-08-18T15:00:00.000Z'),
      endsAt: null,
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        SeasonService,
        SeasonEvents,
        { provide: PvpApi, useValue: { getSeasonIndex, getSeason } },
        { provide: SeasonStateRepository, useValue: { loadAll, save } },
      ],
    }).compile();

    service = moduleRef.get(SeasonService);
    events = [];
    moduleRef.get(SeasonEvents).transitions$.subscribe((event) => events.push(event));
    await service.onModuleInit();
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

  it('persists what it observes, so the next process has something to compare against', async () => {
    getSeasonIndex.mockResolvedValue({ seasons: [], current_season: { id: 42 } });

    await service.refresh('us');

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ region: 'us', seasonId: 42, endsAt: null }),
    );
  });

  it('sees a rollover that happened while the process was down', async () => {
    // What the previous process left behind, and a different season now live.
    loadAll.mockResolvedValue([
      {
        region: 'us',
        seasonId: 42,
        startsAt: new Date('2026-05-01T00:00:00.000Z'),
        endsAt: new Date('2026-08-01T00:00:00.000Z'),
        lastCompletedSeasonId: 41,
        observedAt: new Date('2026-08-01T00:00:00.000Z'),
      },
    ]);
    getSeasonIndex.mockResolvedValue({ seasons: [], current_season: { id: 43 } });
    getSeason.mockResolvedValue({
      id: 43,
      startsAt: new Date('2026-08-18T15:00:00.000Z'),
      endsAt: null,
    });

    await service.onModuleInit();
    expect(service.getCurrentSeason('us')).toBe(42);

    await service.refresh('us');

    // Without persisted state `previous` is undefined on a fresh process and
    // this reads as a first observation, not as a rollover.
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'rollover',
        region: 'us',
        seasonId: 43,
        previousSeasonId: 42,
        acrossRestart: true,
      }),
    ]);
  });

  it('publishes an end date appearing on the season it already knew', async () => {
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
    await service.refresh('eu');

    expect(events).toEqual([
      expect.objectContaining({ kind: 'ended', region: 'eu', seasonId: 42 }),
    ]);
  });
});
