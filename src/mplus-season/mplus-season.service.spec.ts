import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type {
  MplusSeasonDocument,
  MplusSeasonStateDocument,
} from './entities/mplus-season.entity.js';
import type { MplusCatalogueRepository } from './mplus-catalogue.repository.js';
import type { MplusCatalogueService } from './mplus-catalogue.service.js';
import {
  MplusSeasonEvents,
  type MplusSeasonTransitionEvent,
} from './mplus-season-events.service.js';
import type { MplusSeasonStateRepository } from './mplus-season-state.repository.js';
import { MplusSeasonService, resolveRegions } from './mplus-season.service.js';

const PLACEHOLDER_END = new Date('2030-01-01T00:00:00Z');

function season(slug: string, overrides: Partial<MplusSeasonDocument> = {}): MplusSeasonDocument {
  return {
    slug,
    name: slug,
    shortName: null,
    expansionId: 11,
    blizzardSeasonId: 18,
    starts: {},
    ends: {},
    dungeonIds: [1, 2, 3, 4, 5, 6, 7, 8],
    catalogueUpdatedAt: new Date(),
    ...overrides,
  };
}

const mn1 = season('season-mn-1', {
  blizzardSeasonId: 17,
  starts: { us: new Date('2026-03-24T15:00:00Z'), eu: new Date('2026-03-25T04:00:00Z') },
  ends: { us: new Date('2026-08-18T15:00:00Z'), eu: new Date('2026-08-19T04:00:00Z') },
});
const mn2 = season('season-mn-2', {
  starts: { us: new Date('2026-08-18T15:00:00Z'), eu: new Date('2026-08-19T04:00:00Z') },
  ends: { us: PLACEHOLDER_END, eu: PLACEHOLDER_END },
});

describe('resolveRegions', () => {
  it("describes each region's season with its own start and end", () => {
    const resolution = resolveRegions([mn1, mn2], ['us', 'eu'], new Date('2026-09-14T00:00:00Z'));

    expect(resolution.get('eu')).toEqual({
      slug: 'season-mn-2',
      name: 'season-mn-2',
      seasonId: 18,
      expansionId: 11,
      dungeons: 8,
      startsAt: new Date('2026-08-19T04:00:00Z'),
      endsAt: PLACEHOLDER_END,
      ended: false,
    });
  });

  it('marks a season ended once its end in the region has passed, while it is still current', () => {
    // An hour after the US end of season 1 and before season 2 opens there:
    // season 1 is still the board, and it is over.
    const at = new Date('2026-08-18T14:00:00Z');
    const lateMn2 = { ...mn2, starts: { us: new Date('2026-08-18T16:00:00Z') } };
    const earlyEnd = { ...mn1, ends: { us: new Date('2026-08-18T13:00:00Z') } };

    const us = resolveRegions([earlyEnd, lateMn2], ['us'], at).get('us');

    expect(us?.slug).toBe('season-mn-1');
    expect(us?.ended).toBe(true);
  });

  it('leaves out a region no season has opened in', () => {
    const resolution = resolveRegions([mn2], ['us'], new Date('2026-01-01T00:00:00Z'));

    expect(resolution.has('us')).toBe(false);
  });
});

function serviceOver(options: {
  seasons: MplusSeasonDocument[];
  stored?: MplusSeasonStateDocument[];
  count?: number;
}) {
  const catalogueSeasons = { current: options.seasons };
  const repository = {
    allSeasons: vi.fn(async () => catalogueSeasons.current),
    countSeasons: vi.fn(async () => options.count ?? catalogueSeasons.current.length),
  } as unknown as MplusCatalogueRepository;
  const refreshIfDue = vi.fn(async () => ({
    refreshed: false,
    reason: 'fresh',
    expansions: [],
    seasons: 0,
    dungeons: 0,
  }));
  const catalogue = { refreshIfDue } as unknown as MplusCatalogueService;
  const save = vi.fn(async () => undefined);
  const state = {
    loadAll: vi.fn(async () => options.stored ?? []),
    save,
  } as unknown as MplusSeasonStateRepository;
  const events = new MplusSeasonEvents();
  const emitted: MplusSeasonTransitionEvent[] = [];
  events.transitions$.subscribe((event) => emitted.push(event));
  const config = {
    get: () => ['us', 'eu'],
  } as unknown as ConfigService<never, true>;

  return {
    service: new MplusSeasonService(config, catalogue, repository, state, events),
    catalogueSeasons,
    emitted,
    save,
    refreshIfDue,
  };
}

describe('MplusSeasonService.observe', () => {
  it('announces nothing on the first observation, but records it', async () => {
    const { service, emitted, save } = serviceOver({ seasons: [mn1, mn2] });

    await service.observe(new Date('2026-09-14T00:00:00Z'));

    expect(emitted).toEqual([]);
    expect(save).toHaveBeenCalledTimes(2);
    expect(service.describe().us.season).toBe('season-mn-2');
  });

  it('writes nothing when nothing changed', async () => {
    const { service, save } = serviceOver({ seasons: [mn1, mn2] });

    await service.observe(new Date('2026-09-14T00:00:00Z'));
    await service.observe(new Date('2026-09-14T01:00:00Z'));

    expect(save, 'only the first observation of each region').toHaveBeenCalledTimes(2);
  });

  it('announces a rollover per region, as each region opens the new season', async () => {
    const { service, emitted } = serviceOver({ seasons: [mn1, mn2] });

    await service.observe(new Date('2026-08-18T12:00:00Z'));
    // The US has opened season 2; Europe opens it at 04:00 the next day.
    await service.observe(new Date('2026-08-18T20:00:00Z'));

    // A rollover, not an end and then a rollover: the season was replaced
    // before an ended observation of it was ever made, as on the PvP side.
    expect(emitted.map((event) => [event.kind, event.region, event.previousSeason])).toEqual([
      ['rollover', 'us', 'season-mn-1'],
    ]);

    await service.observe(new Date('2026-08-19T05:00:00Z'));

    expect(emitted.slice(1).map((event) => [event.kind, event.region, event.season])).toEqual([
      ['rollover', 'eu', 'season-mn-2'],
    ]);
  });

  it('announces a season ending while it is still the current one', async () => {
    const { service, emitted, catalogueSeasons } = serviceOver({ seasons: [mn2] });

    await service.observe(new Date('2026-09-14T00:00:00Z'));

    // Raider.io replaces the 2030 placeholder with the real end.
    catalogueSeasons.current = [
      {
        ...mn2,
        ends: { us: new Date('2026-09-15T15:00:00Z'), eu: new Date('2026-09-16T04:00:00Z') },
      },
    ];
    await service.observe(new Date('2026-09-15T16:00:00Z'));

    expect(emitted).toEqual([
      expect.objectContaining({
        kind: 'ended',
        region: 'us',
        season: 'season-mn-2',
        previousSeason: 'season-mn-2',
        at: new Date('2026-09-15T15:00:00Z'),
      }),
    ]);
  });

  it('recognises a rollover that happened while the process was down', async () => {
    const { service, emitted } = serviceOver({
      seasons: [mn1, mn2],
      stored: [
        {
          region: 'us',
          season: 'season-mn-1',
          name: 'season-mn-1',
          startsAt: new Date('2026-03-24T15:00:00Z'),
          endsAt: PLACEHOLDER_END,
          ended: false,
          observedAt: new Date('2026-08-01T00:00:00Z'),
        },
      ],
    });

    await service.onModuleInit();
    await service.observe(new Date('2026-09-14T00:00:00Z'));

    expect(emitted).toEqual([
      expect.objectContaining({ kind: 'rollover', region: 'us', acrossRestart: true }),
    ]);
  });
});

describe('MplusSeasonService.ensureCatalogue', () => {
  it('refreshes the catalogue when due', async () => {
    const { service, refreshIfDue } = serviceOver({ seasons: [mn2] });

    await service.ensureCatalogue();

    expect(refreshIfDue).toHaveBeenCalledTimes(1);
  });

  it('refuses to go on with an empty catalogue', async () => {
    const { service } = serviceOver({ seasons: [], count: 0 });

    await expect(service.ensureCatalogue()).rejects.toThrow(/catalogue is empty/);
  });
});
