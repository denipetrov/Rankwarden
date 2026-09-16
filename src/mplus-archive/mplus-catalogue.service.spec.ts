import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { MythicPlusApi } from '../raiderio/mythic-plus.api.js';
import type { StaticData, StaticSeason } from '../raiderio/schemas/static-data.schema.js';
import type { MplusArchiveRepository } from './mplus-archive.repository.js';
import { MplusCatalogueService } from './mplus-catalogue.service.js';

function season(slug: string, main: boolean, dungeonId: number): StaticSeason {
  return {
    slug,
    name: slug,
    is_main_season: main,
    starts: { us: '2024-01-01T00:00:00Z' },
    ends: { us: '2024-06-01T00:00:00Z' },
    dungeons: [{ id: dungeonId, slug: `d-${dungeonId}`, name: `Dungeon ${dungeonId}` }],
  };
}

function serviceOver(byExpansion: Record<number, StaticSeason[]>) {
  const api = {
    getStaticData: vi.fn(async (expansionId: number): Promise<StaticData> => ({
      seasons: byExpansion[expansionId] ?? [],
    })),
  } as unknown as MythicPlusApi;
  const upsertSeasons = vi.fn(async (seasons: unknown[]) => seasons.length);
  const upsertDungeons = vi.fn(async (dungeons: unknown[]) => dungeons.length);
  const repository = { upsertSeasons, upsertDungeons } as unknown as MplusArchiveRepository;
  const env: Record<string, unknown> = {
    MPLUS_CATALOGUE_FIRST_EXPANSION: 6,
    MPLUS_CATALOGUE_TTL_MS: 86_400_000,
  };
  const config = { get: (key: string) => env[key] } as unknown as ConfigService<never, true>;

  return {
    service: new MplusCatalogueService(config, api, repository),
    upsertSeasons,
    upsertDungeons,
  };
}

describe('MplusCatalogueService.refresh', () => {
  it('stores main seasons only, and the dungeons of main seasons only', async () => {
    const { service, upsertSeasons, upsertDungeons } = serviceOver({
      6: [season('season-7.2.0', true, 1), season('season-post-legion', false, 2)],
    });

    await service.refresh();

    const stored = upsertSeasons.mock.calls.flatMap(([seasons]) =>
      (seasons as { slug: string }[]).map((item) => item.slug),
    );
    expect(stored).toEqual(['season-7.2.0']);

    const dungeons = upsertDungeons.mock.calls.flatMap(([items]) =>
      (items as { id: number }[]).map((item) => item.id),
    );
    expect(dungeons, 'a dungeon only a side event ran is not stored').toEqual([1]);
  });

  /**
   * The end of the walk is decided on everything Raider.io lists, not on main
   * seasons. Decided on main seasons, an expansion listing only side events
   * would end the walk and every expansion after it would go unread.
   */
  it('walks past an expansion that lists only side events', async () => {
    const { service } = serviceOver({
      6: [season('season-7.2.0', true, 1)],
      7: [season('season-side-only', false, 2)],
      8: [season('season-sl-1', true, 3)],
    });

    const result = await service.refresh();

    expect(result.expansions).toEqual([6, 7, 8]);
  });

  it('stops at the first expansion that lists nothing at all', async () => {
    const { service } = serviceOver({ 6: [season('season-7.2.0', true, 1)] });

    const result = await service.refresh();

    expect(result.expansions).toEqual([6]);
  });
});
