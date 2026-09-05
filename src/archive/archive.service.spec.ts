import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PvpApi } from '../blizzard/pvp.api.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { SeasonService } from '../season/season.service.js';
import { ArchiveRepository } from './archive.repository.js';
import { ArchiveService } from './archive.service.js';

const env: Record<string, unknown> = {
  BLIZZARD_REGIONS: ['us', 'eu'],
  ARCHIVE_CONCURRENCY: 2,
  ARCHIVE_REQUESTS_PER_SECOND: 1000,
  ARCHIVE_MIN_SEASON: 0,
  ARCHIVE_MAX_SEASON: 0,
  ARCHIVE_MAX_ENTRIES_PER_BRACKET: 3,
};

describe('ArchiveService', () => {
  const getSeasonIndex = vi.fn();
  const getBrackets = vi.fn();
  const getLeaderboard = vi.fn();
  const getSeason = vi.fn();
  const completedSeasons = vi.fn();
  const insertEntries = vi.fn();
  const recordSeason = vi.fn();
  const countEntries = vi.fn();
  const hasStoredEntries = vi.fn();
  const summariseStored = vi.fn();
  const hasEnded = vi.fn();
  let coordinator: IngestionCoordinator;
  let service: ArchiveService;

  beforeEach(async () => {
    vi.clearAllMocks();
    getSeasonIndex.mockResolvedValue({
      seasons: [{ id: 40 }, { id: 41 }, { id: 42 }],
      current_season: { id: 42 },
    });
    getBrackets.mockResolvedValue(['3v3', 'shuffle-overall']);
    getLeaderboard.mockResolvedValue({
      season: { id: 41 },
      name: '3v3',
      bracket: { id: 2, type: 'ARENA_3v3' },
      entries: [
        {
          character: { id: 7, name: 'Warden', realm: { id: 60, slug: 'tarren-mill' } },
          faction: { type: 'HORDE' },
          rank: 1,
          rating: 3000,
          season_match_statistics: { played: 100, won: 70, lost: 30 },
        },
      ],
    });
    getSeason.mockResolvedValue({
      id: 41,
      name: 'Midnight Season 1',
      startsAt: new Date('2026-03-17T15:00:00.000Z'),
      endsAt: new Date('2026-08-11T05:00:00.000Z'),
    });
    completedSeasons.mockResolvedValue(new Set<string>());
    countEntries.mockResolvedValue(1);
    hasStoredEntries.mockResolvedValue(false);
    summariseStored.mockResolvedValue({ brackets: 83, entries: 297119 });
    hasEnded.mockReturnValue(false);
    coordinator = new IngestionCoordinator();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ArchiveService,
        { provide: IngestionCoordinator, useValue: coordinator },
        { provide: PvpApi, useValue: { getSeasonIndex, getBrackets, getLeaderboard, getSeason } },
        { provide: SeasonService, useValue: { hasEnded } },
        {
          provide: ArchiveRepository,
          useValue: {
            completedSeasons,
            insertEntries,
            recordSeason,
            countEntries,
            hasStoredEntries,
            summariseStored,
          },
        },
        { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
      ],
    }).compile();

    service = moduleRef.get(ArchiveService);
  });

  it('offers the newest finished season first', async () => {
    // 42 is still running, so 41 is the most recent history worth having.
    await expect(service.nextPending()).resolves.toEqual({ seasonId: 41, region: 'us' });
  });

  it('never offers the active season while it is still running', async () => {
    completedSeasons.mockResolvedValue(new Set(['41:us', '40:us', '41:eu', '40:eu']));

    await expect(service.nextPending()).resolves.toBeNull();
  });

  it('offers the active season once it has ended', async () => {
    completedSeasons.mockResolvedValue(new Set(['41:us', '40:us', '41:eu', '40:eu']));
    hasEnded.mockReturnValue(true);

    await expect(service.nextPending()).resolves.toEqual({ seasonId: 42, region: 'us' });
  });

  it('honours a season range so one season can be targeted', async () => {
    env.ARCHIVE_MIN_SEASON = 40;
    env.ARCHIVE_MAX_SEASON = 40;
    const bounded = await Test.createTestingModule({
      providers: [
        ArchiveService,
        { provide: IngestionCoordinator, useValue: coordinator },
        { provide: PvpApi, useValue: { getSeasonIndex, getBrackets, getLeaderboard, getSeason } },
        { provide: SeasonService, useValue: { hasEnded } },
        {
          provide: ArchiveRepository,
          useValue: {
            completedSeasons,
            insertEntries,
            recordSeason,
            countEntries,
            hasStoredEntries,
            summariseStored,
          },
        },
        { provide: ConfigService, useValue: { get: (key: string) => env[key] } },
      ],
    }).compile();
    env.ARCHIVE_MIN_SEASON = 0;
    env.ARCHIVE_MAX_SEASON = 0;

    // 41 is newer and unarchived, but out of range.
    await expect(bounded.get(ArchiveService).nextPending()).resolves.toEqual({
      seasonId: 40,
      region: 'us',
    });
  });

  it('does not re-fetch a season that is already archived', async () => {
    completedSeasons.mockResolvedValue(new Set(['41:us']));

    await expect(service.nextPending()).resolves.toEqual({ seasonId: 40, region: 'us' });
  });

  it('skips a season whose rows are already stored, even with no marker', async () => {
    // A crash mid-season, or a dropped markers collection: the data is there and
    // historical data never changes, so re-fetching it is pure waste.
    hasStoredEntries.mockResolvedValue(true);

    await expect(service.nextPending()).resolves.toBeNull();
    expect(getLeaderboard).not.toHaveBeenCalled();
  });

  it('writes back the missing marker so the next startup is cheaper still', async () => {
    hasStoredEntries.mockResolvedValue(true);

    await service.nextPending();

    expect(recordSeason).toHaveBeenCalledWith(
      expect.objectContaining({ seasonId: 41, region: 'us', brackets: 83, entries: 297119 }),
    );
  });

  it('fetches when nothing is stored for the season', async () => {
    hasStoredEntries.mockResolvedValue(false);

    await expect(service.nextPending()).resolves.toEqual({ seasonId: 41, region: 'us' });
    expect(recordSeason).not.toHaveBeenCalled();
  });

  it('stores only leaderboard fields, with no profile lookup', async () => {
    await service.archiveSeason(41, 'us');

    expect(insertEntries).toHaveBeenCalledWith([
      {
        seasonId: 41,
        region: 'us',
        bracket: '3v3',
        characterId: 7,
        characterName: 'Warden',
        realmId: 60,
        realmSlug: 'tarren-mill',
        faction: 'HORDE',
        rank: 1,
        rating: 3000,
        played: 100,
        won: 70,
        lost: 30,
      },
    ]);
  });

  it('skips the aggregate brackets the live sweep skips too', async () => {
    await service.archiveSeason(41, 'us');

    expect(getLeaderboard).toHaveBeenCalledOnce();
    expect(getLeaderboard).toHaveBeenCalledWith('us', 41, '3v3');
  });

  it('records a season so it is not archived twice', async () => {
    await service.archiveSeason(41, 'us');

    expect(recordSeason).toHaveBeenCalledWith(
      expect.objectContaining({ seasonId: 41, region: 'us', brackets: 1, failedBrackets: [] }),
    );
  });

  it('leaves a season incomplete when a bracket fails, so it is retried', async () => {
    getLeaderboard.mockRejectedValue(new Error('502 Bad Gateway'));

    const result = await service.archiveSeason(41, 'us');

    expect(result.failedBrackets).toEqual(['3v3']);
    expect(recordSeason).toHaveBeenCalledWith(expect.objectContaining({ failedBrackets: ['3v3'] }));
  });

  it('keeps the highest rated entries when a bracket exceeds the cap', async () => {
    const entry = (id: number, rating: number) => ({
      character: { id, name: `C${id}`, realm: { id: 1, slug: 'realm' } },
      rank: id,
      rating,
      season_match_statistics: { played: 1, won: 1, lost: 0 },
    });
    // Deliberately out of order, to prove it sorts rather than trusting rank.
    getLeaderboard.mockResolvedValue({
      season: { id: 41 },
      name: '3v3',
      bracket: { id: 2, type: 'ARENA_3v3' },
      entries: [entry(1, 1500), entry(2, 2900), entry(3, 1800), entry(4, 2500), entry(5, 2100)],
    });

    await service.archiveSeason(41, 'us');

    const [documents] = insertEntries.mock.calls[0];
    expect(documents.map((d: { rating: number }) => d.rating)).toEqual([2900, 2500, 2100]);
  });

  it('yields to a running sweep instead of competing for the quota', async () => {
    await coordinator.duringSweep(async () => {
      const result = await service.archiveSeason(41, 'us');

      expect(getLeaderboard).not.toHaveBeenCalled();
      // Marked failed, so the season stays pending and is picked up later.
      expect(result.failedBrackets).toEqual(['3v3']);
    });
  });

  it('yields to profile enrichment as well, not only to sweeps', async () => {
    await coordinator.duringEnrichment(async () => {
      const result = await service.archiveSeason(41, 'us');

      expect(getLeaderboard).not.toHaveBeenCalled();
      expect(result.failedBrackets).toEqual(['3v3']);
    });
  });
});
