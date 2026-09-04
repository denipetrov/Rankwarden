import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ProfileApi } from '../blizzard/profile.api.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { CharacterRepository } from '../leaderboard/character.repository.js';
import type { CharacterDocument } from '../leaderboard/entities/character.entity.js';
import { ProfileEnrichmentService } from './profile-enrichment.service.js';

const DAY = 86_400_000;
const WEEK = 604_800_000;

const env: Record<string, unknown> = {
  PROFILE_BATCH_SIZE: 10,
  PROFILE_SUMMARY_TTL_MS: WEEK,
  PROFILE_SPECS_TTL_MS: DAY,
  PROFILE_CONCURRENCY: 2,
  PROFILE_REQUESTS_PER_SECOND: 1000,
};

const character = (overrides: Partial<CharacterDocument> = {}): CharacterDocument =>
  ({
    seasonId: 42,
    region: 'eu',
    characterId: 1,
    characterName: 'Warden',
    realmId: 60,
    realmSlug: 'tarren-mill',
    faction: 'HORDE',
    brackets: {},
    ratings: {},
    updatedAt: new Date(),
    ...overrides,
  }) as CharacterDocument;

const summaryPayload = {
  id: 1,
  name: 'Warden',
  level: 90,
  race: { id: 10, name: 'Blood Elf' },
  character_class: { id: 2, name: 'Paladin' },
  realm: { id: 60, name: 'Tarren Mill', slug: 'tarren-mill' },
  active_title: { id: 654, name: 'Gladiator', display_string: 'Gladiator {name}' },
};

describe('ProfileEnrichmentService', () => {
  const getProfile = vi.fn();
  const getSpecializations = vi.fn();
  const findProfilesToEnrich = vi.fn();
  const saveProfileSummary = vi.fn();
  const saveProfileSpecs = vi.fn();
  const markProfileMissing = vi.fn();
  let coordinator: IngestionCoordinator;
  let service: ProfileEnrichmentService;

  beforeEach(async () => {
    vi.clearAllMocks();
    getProfile.mockResolvedValue(summaryPayload);
    getSpecializations.mockResolvedValue({
      active_specialization: { id: 65, name: 'Holy' },
      active_hero_talent_tree: { id: 49, name: 'Lightsmith' },
    });
    coordinator = new IngestionCoordinator();

    const moduleRef = await Test.createTestingModule({
      providers: [
        ProfileEnrichmentService,
        { provide: IngestionCoordinator, useValue: coordinator },
        { provide: ProfileApi, useValue: { getProfile, getSpecializations } },
        {
          provide: CharacterRepository,
          useValue: {
            findProfilesToEnrich,
            saveProfileSummary,
            saveProfileSpecs,
            markProfileMissing,
          },
        },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => env[key] },
        },
      ],
    }).compile();

    service = moduleRef.get(ProfileEnrichmentService);
  });

  it('fetches both endpoints for a character that has never been enriched', async () => {
    findProfilesToEnrich.mockResolvedValue([character()]);

    const result = await service.run();

    expect(getProfile).toHaveBeenCalledOnce();
    expect(getSpecializations).toHaveBeenCalledOnce();
    expect(result?.requests).toBe(2);
  });

  it('skips the summary endpoint while it is inside its longer TTL', async () => {
    findProfilesToEnrich.mockResolvedValue([
      character({
        profileFetchedAt: new Date(Date.now() - DAY), // fresh against the 7-day TTL
        specsFetchedAt: new Date(Date.now() - 2 * DAY), // stale against the 1-day TTL
      }),
    ]);

    const result = await service.run();

    expect(getProfile).not.toHaveBeenCalled();
    expect(getSpecializations).toHaveBeenCalledOnce();
    expect(saveProfileSummary).not.toHaveBeenCalled();
    expect(saveProfileSpecs).toHaveBeenCalledOnce();
    // Half the requests of a full refresh — the point of splitting the TTLs.
    expect(result?.requests).toBe(1);
  });

  it('stores the active title display string and realm name', async () => {
    findProfilesToEnrich.mockResolvedValue([character()]);

    await service.run();

    expect(saveProfileSummary).toHaveBeenCalledWith(
      42,
      'eu',
      1,
      expect.objectContaining({ realmName: 'Tarren Mill', title: 'Gladiator {name}' }),
      expect.any(Date),
    );
  });

  it('leaves the title null when no title is equipped', async () => {
    getProfile.mockResolvedValue({ ...summaryPayload, active_title: undefined });
    findProfilesToEnrich.mockResolvedValue([character()]);

    await service.run();

    expect(saveProfileSummary).toHaveBeenCalledWith(
      42,
      'eu',
      1,
      expect.objectContaining({ title: null }),
      expect.any(Date),
    );
  });

  it('refuses to start while a ladder sweep is running', async () => {
    findProfilesToEnrich.mockResolvedValue([character()]);

    await coordinator.duringSweep(async () => {
      expect(await service.run()).toBeNull();
    });

    expect(findProfilesToEnrich).not.toHaveBeenCalled();
    expect(getProfile).not.toHaveBeenCalled();
  });
});
