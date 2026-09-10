import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ZodError } from 'zod';

import { ProfileApi } from '../blizzard/profile.api.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { QuotaBudget } from '../common/quota/quota-budget.service.js';
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
  PROFILE_INTERVAL_MS: 300_000,
  QUOTA_HOURLY_LIMIT: 36_000,
  QUOTA_UTILISATION: 0.9,
  QUOTA_ENRICHMENT_HEADROOM: 3,
  QUOTA_SWEEP_RESERVE: 1_000,
};

const character = (overrides: Partial<CharacterDocument> = {}): CharacterDocument =>
  ({
    seasonId: 42,
    region: 'eu',
    characterId: 1,
    characterType: 'PvP',
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
  const countEnrichmentDemand = vi.fn();
  const population = vi.fn();
  const oldestSpecsRefresh = vi.fn();
  let budget: QuotaBudget;

  /**
   * Builds the service with optional config overrides. The service reads its
   * settings in the constructor, so a case that needs a different batch size
   * has to build its own rather than mutate `env` afterwards.
   */
  const build = async (overrides: Record<string, unknown> = {}) => {
    const settings = { ...env, ...overrides };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ProfileEnrichmentService,
        { provide: IngestionCoordinator, useValue: coordinator },
        { provide: QuotaBudget, useValue: budget },
        { provide: ProfileApi, useValue: { getProfile, getSpecializations } },
        {
          provide: CharacterRepository,
          useValue: {
            findProfilesToEnrich,
            saveProfileSummary,
            saveProfileSpecs,
            markProfileMissing,
            markProfileUnreadable,
            countEnrichmentDemand,
            population,
            oldestSpecsRefresh,
          },
        },
        { provide: ConfigService, useValue: { get: (key: string) => settings[key] } },
      ],
    }).compile();

    return moduleRef.get(ProfileEnrichmentService);
  };
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
    budget = new QuotaBudget({ get: (key: string) => env[key] } as never);
    // Plenty due by default, so the batch is bounded by PROFILE_BATCH_SIZE and
    // the existing cases keep driving what is fetched through the selection mock.
    countEnrichmentDemand.mockResolvedValue({ characters: 10_000, requests: 20_000 });
    population.mockResolvedValue(1000);
    oldestSpecsRefresh.mockResolvedValue(null);

    service = await build();
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

  describe('sizing a run from demand and the quota', () => {
    beforeEach(() => {
      findProfilesToEnrich.mockResolvedValue([character()]);
    });

    const requestedLimit = () => findProfilesToEnrich.mock.calls[0][2] as number;

    it('never asks for more characters than are due', async () => {
      countEnrichmentDemand.mockResolvedValue({ characters: 3, requests: 6 });

      await service.run();

      expect(requestedLimit()).toBe(3);
    });

    it('spends the budget on more characters when only their specs are due', async () => {
      // One request each instead of two, so the same budget buys twice as many.
      // A fixed batch could not tell the difference.
      const roomy = await build({ PROFILE_BATCH_SIZE: 100_000 });
      countEnrichmentDemand.mockResolvedValue({ characters: 50_000, requests: 50_000 });

      await roomy.run();
      const specsOnly = requestedLimit();

      findProfilesToEnrich.mockClear();
      countEnrichmentDemand.mockResolvedValue({ characters: 50_000, requests: 100_000 });
      await roomy.run();

      expect(specsOnly).toBe(requestedLimit() * 2);
    });

    it('paces a run to its share of the hour, with room to catch up', async () => {
      // 12,000 an hour over 12 runs is 1,000 a run; one run may take two to
      // make up a skipped one, never the whole hour in a burst.
      const roomy = await build({ PROFILE_BATCH_SIZE: 100_000 });
      countEnrichmentDemand.mockResolvedValue({ characters: 50_000, requests: 50_000 });

      await roomy.run();

      expect(requestedLimit()).toBe(2_000);
    });

    it('treats PROFILE_BATCH_SIZE as a ceiling, not the batch', async () => {
      countEnrichmentDemand.mockResolvedValue({ characters: 5_000, requests: 5_000 });

      await service.run();

      expect(requestedLimit()).toBe(env.PROFILE_BATCH_SIZE);
    });

    it('fetches nothing once the enrichment share is spent', async () => {
      budget.record('enrichment', budget.enrichmentShare);

      const result = await service.run();

      expect(findProfilesToEnrich).not.toHaveBeenCalled();
      expect(result?.selected).toBe(0);
    });

    it('gives way to a sweep and archive that have already spent the hour', async () => {
      // Enrichment's share is a ceiling, not a guarantee: what the other jobs
      // have really spent comes first.
      budget.record('sweep', budget.usable);

      await service.run();

      expect(findProfilesToEnrich).not.toHaveBeenCalled();
    });

    it('publishes an outlook health can report without querying anything', async () => {
      // At the real default batch ceiling; this spec's own ceiling of 10 would
      // correctly report the batch size as binding and the TTLs as unkeepable.
      const defaults = await build({ PROFILE_BATCH_SIZE: 2_000 });
      population.mockResolvedValue(143_203);
      countEnrichmentDemand.mockResolvedValue({ characters: 42, requests: 60 });

      await defaults.run();

      expect(budget.enrichmentOutlook).toMatchObject({
        population: 143_203,
        dueCharacters: 42,
        dueRequests: 60,
        feasible: true,
        bindingConstraint: 'quota share',
      });
    });

    it('reports the batch size as binding when it is too small to keep the TTLs', async () => {
      // This spec's own ceiling of 10 a run: the outlook has to say so, and name
      // the batch rather than the quota as the thing to change.
      population.mockResolvedValue(143_203);

      await service.run();

      expect(budget.enrichmentOutlook).toMatchObject({
        feasible: false,
        bindingConstraint: 'batch size',
      });
    });

    it('never lets a failing outlook cost the run', async () => {
      population.mockRejectedValue(new Error('mongo is slow'));

      await expect(service.run()).resolves.toMatchObject({ selected: 1 });
    });
  });
});
