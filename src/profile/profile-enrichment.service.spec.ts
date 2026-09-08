import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ZodError } from 'zod';

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
  PROFILE_RETRY_BACKOFF_MS: 900_000,
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
  const markProfileUnreadable = vi.fn();
  let coordinator: IngestionCoordinator;
  let service: ProfileEnrichmentService;

  beforeEach(async () => {
    vi.clearAllMocks();
    getProfile.mockResolvedValue(summaryPayload);
    getSpecializations.mockResolvedValue({
      active_specialization: { id: 65, name: 'Holy' },
      active_hero_talent_tree: { id: 49, name: 'Lightsmith' },
      specializations: [
        {
          specialization: { id: 70, name: 'Retribution' },
          loadouts: [
            {
              is_active: true,
              talent_loadout_code: 'RET-CODE',
              selected_hero_talent_tree: { id: 50, name: 'Templar' },
            },
          ],
        },
        {
          specialization: { id: 65, name: 'Holy' },
          loadouts: [
            { is_active: false, talent_loadout_code: 'HOLY-BACKUP' },
            {
              is_active: true,
              talent_loadout_code: 'HOLY-CODE',
              selected_hero_talent_tree: { id: 49, name: 'Lightsmith' },
            },
          ],
        },
      ],
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
            markProfileUnreadable,
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

  it("stores each spec's own loadout and hero tree, not the active spec's", async () => {
    findProfilesToEnrich.mockResolvedValue([character()]);

    await service.run();

    expect(saveProfileSpecs).toHaveBeenCalledWith(
      42,
      'eu',
      1,
      expect.objectContaining({
        talentLoadouts: [
          {
            spec: { id: 70, name: 'Retribution' },
            talentLoadoutCode: 'RET-CODE',
            heroTalentTree: { id: 50, name: 'Templar' },
          },
          {
            spec: { id: 65, name: 'Holy' },
            talentLoadoutCode: 'HOLY-CODE',
            heroTalentTree: { id: 49, name: 'Lightsmith' },
          },
        ],
      }),
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

  describe('a character whose profile cannot be read', () => {
    beforeEach(() => {
      findProfilesToEnrich.mockResolvedValue([character()]);
    });

    it('stamps the failing half so it stops sorting first forever', async () => {
      // Selection sorts by the fetch timestamps ascending and an absent field
      // sorts before every date, so a failure that stamps nothing is reselected
      // on every pass — and once enough accumulate to fill a batch, nobody else
      // is ever enriched again.
      getProfile.mockRejectedValue(new ZodError([]));

      const result = await service.run();

      expect(result?.failed).toBe(1);
      expect(markProfileUnreadable).toHaveBeenCalledWith(
        42,
        'eu',
        1,
        'summary',
        expect.any(Date),
        true,
      );
    });

    it('stamps the spec half when that is the half that failed', async () => {
      getSpecializations.mockRejectedValue(new ZodError([]));

      await service.run();

      expect(markProfileUnreadable).toHaveBeenCalledWith(
        42,
        'eu',
        1,
        'specs',
        expect.any(Date),
        true,
      );
    });

    it('waits out the full TTL for a schema failure, which will not fix itself', async () => {
      getSpecializations.mockRejectedValue(new ZodError([]));

      await service.run();

      const [, , , , retryAfter, permanent] = markProfileUnreadable.mock.calls[0];
      expect(permanent).toBe(true);
      // Stamped as of now, so the character is due again one whole TTL later.
      expect(Date.now() - (retryAfter as Date).getTime()).toBeLessThan(1_000);
    });

    it('retries a transient failure after the backoff, not a whole TTL', async () => {
      // A timeout says nothing about the character, so making it wait a day
      // would be its own kind of data loss.
      getSpecializations.mockRejectedValue(new Error('socket hang up'));

      await service.run();

      const [, , , , retryAfter, permanent] = markProfileUnreadable.mock.calls[0];
      expect(permanent).toBe(false);

      // Backdated to just short of the TTL, so it comes due again in ~15m.
      const dueIn = (retryAfter as Date).getTime() + DAY - Date.now();
      expect(dueIn).toBeGreaterThan(890_000);
      expect(dueIn).toBeLessThan(910_000);
    });

    it('keeps a 404 distinct from an unreadable payload', async () => {
      // A missing character is gone; an unparseable one is alive with a payload
      // we could not read, and its stored profile stays put.
      getProfile.mockResolvedValue(null);

      const result = await service.run();

      expect(result?.missing).toBe(1);
      expect(markProfileMissing).toHaveBeenCalled();
      expect(markProfileUnreadable).not.toHaveBeenCalled();
    });

    it('does not throw when recording the failure itself fails', async () => {
      getSpecializations.mockRejectedValue(new ZodError([]));
      markProfileUnreadable.mockRejectedValueOnce(new Error('mongo is gone'));

      await expect(service.run()).resolves.toMatchObject({ failed: 1 });
    });
  });

  describe('hero talent tree', () => {
    it('prefers the top-level field Blizzard sends', async () => {
      findProfilesToEnrich.mockResolvedValue([character()]);

      await service.run();

      expect(saveProfileSpecs.mock.calls[0][3]).toMatchObject({
        heroTalentTree: { id: 49, name: 'Lightsmith' },
      });
    });

    it("falls back to the active spec's own loadout when the field is absent", async () => {
      // The field is optional. Storing null when the loadouts already carry the
      // answer would quietly drain hero talent coverage for 2v2, 3v3 and rbg,
      // whose representation counts read this field and no other.
      getSpecializations.mockResolvedValue({
        active_specialization: { id: 65, name: 'Holy' },
        specializations: [
          {
            specialization: { id: 70, name: 'Retribution' },
            loadouts: [
              {
                is_active: true,
                talent_loadout_code: 'RET-CODE',
                selected_hero_talent_tree: { id: 50, name: 'Templar' },
              },
            ],
          },
          {
            specialization: { id: 65, name: 'Holy' },
            loadouts: [
              {
                is_active: true,
                talent_loadout_code: 'HOLY-CODE',
                selected_hero_talent_tree: { id: 49, name: 'Lightsmith' },
              },
            ],
          },
        ],
      });
      findProfilesToEnrich.mockResolvedValue([character()]);

      await service.run();

      // Holy's own tree, not Retribution's, which is the trap §9.2 documents.
      expect(saveProfileSpecs.mock.calls[0][3]).toMatchObject({
        heroTalentTree: { id: 49, name: 'Lightsmith' },
      });
    });

    it('stores null when neither source has one', async () => {
      getSpecializations.mockResolvedValue({
        active_specialization: { id: 65, name: 'Holy' },
        specializations: [
          {
            specialization: { id: 65, name: 'Holy' },
            loadouts: [{ is_active: true, talent_loadout_code: 'HOLY-CODE' }],
          },
        ],
      });
      findProfilesToEnrich.mockResolvedValue([character()]);

      await service.run();

      expect(saveProfileSpecs.mock.calls[0][3]).toMatchObject({ heroTalentTree: null });
    });
  });
});
