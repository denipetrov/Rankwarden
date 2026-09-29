import type { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import type { MythicPlusApi } from '../raiderio/mythic-plus.api.js';
import type { StaticData, StaticSeason } from '../raiderio/schemas/static-data.schema.js';
import type { MplusCatalogueRepository } from './mplus-catalogue.repository.js';
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

function serviceOver(
  byExpansion: Record<number, StaticSeason[]>,
  options: { failing?: number[]; updatedAt?: Date | null } = {},
) {
  const getStaticData = vi.fn(async (expansionId: number): Promise<StaticData> => {
    if (options.failing?.includes(expansionId)) throw new Error(`expansion ${expansionId} down`);

    return { seasons: byExpansion[expansionId] ?? [] };
  });
  const api = { getStaticData } as unknown as MythicPlusApi;
  const upsertSeasons = vi.fn(async (seasons: unknown[]) => seasons.length);
  const upsertDungeons = vi.fn(async (dungeons: unknown[]) => dungeons.length);
  const catalogueUpdatedAt = vi.fn(async () => options.updatedAt ?? null);
  const markUnlisted = vi.fn(async () => 0);
  const repository = {
    upsertSeasons,
    upsertDungeons,
    catalogueUpdatedAt,
    markUnlisted,
  } as unknown as MplusCatalogueRepository;
  const env: Record<string, unknown> = {
    MPLUS_CATALOGUE_FIRST_EXPANSION: 6,
    MPLUS_CATALOGUE_TTL_MS: 86_400_000,
  };
  const config = { get: (key: string) => env[key] } as unknown as ConfigService<never, true>;

  return {
    service: new MplusCatalogueService(config, api, repository),
    upsertSeasons,
    upsertDungeons,
    getStaticData,
    markUnlisted,
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

  /**
   * C4. A failure skipped would read the next id as "the one after", and a
   * transient outage on one expansion would then look exactly like the end of
   * the list: everything after it would silently go unrefreshed.
   */
  it('stops the walk at an expansion that fails, keeping what was written', async () => {
    const { service, getStaticData, upsertSeasons } = serviceOver(
      {
        6: [season('season-7.2.0', true, 1)],
        7: [season('season-bfa-1', true, 2)],
        8: [season('season-sl-1', true, 3)],
      },
      { failing: [7] },
    );

    const result = await service.refresh();

    expect(result.expansions).toEqual([6]);
    expect(result.refreshed).toBe(true);
    expect(
      getStaticData.mock.calls.map(([id]) => id),
      'never asks for 8',
    ).toEqual([6, 7]);
    expect(upsertSeasons).toHaveBeenCalledTimes(1);
  });

  /**
   * C6. Judged by the newest stamp, a walk that failed partway would read as
   * fresh for a whole TTL, and the expansions it never reached would stay stale
   * that long. The repository answers with the oldest; this is what the
   * service does with it.
   */
  it('walks when the oldest stamp is past the TTL, however fresh the rest are', async () => {
    const day = 86_400_000;
    const now = new Date('2026-09-25T12:00:00Z');
    const stale = serviceOver(
      { 6: [season('season-7.2.0', true, 1)] },
      { updatedAt: new Date(now.getTime() - day - 1) },
    );
    const fresh = serviceOver(
      { 6: [season('season-7.2.0', true, 1)] },
      { updatedAt: new Date(now.getTime() - day + 60_000) },
    );

    expect((await stale.service.refreshIfDue(now)).refreshed).toBe(true);
    const skipped = await fresh.service.refreshIfDue(now);
    expect(skipped.refreshed).toBe(false);
    expect(skipped.reason).toMatch(/catalogue is fresh/);
    expect(fresh.getStaticData).not.toHaveBeenCalled();
  });

  it('refreshes an empty catalogue whatever the TTL', async () => {
    const { service, getStaticData } = serviceOver({ 6: [season('season-7.2.0', true, 1)] });

    expect((await service.refreshIfDue()).refreshed).toBe(true);
    expect(getStaticData).toHaveBeenCalled();
  });

  /**
   * F6. "No longer listed" is only known at the end of the list: a walk that
   * stopped on a failure has not seen the later expansions, and marking their
   * seasons unlisted would take them out of the freshness check it relies on.
   */
  it('marks unlisted seasons only after a walk that reached the end', async () => {
    const complete = serviceOver({ 6: [season('season-7.2.0', true, 1)] });
    const now = new Date('2026-09-25T12:00:00Z');
    await complete.service.refresh(now);
    expect(complete.markUnlisted).toHaveBeenCalledWith(now);

    const failed = serviceOver(
      { 6: [season('season-7.2.0', true, 1)], 7: [season('season-bfa-1', true, 2)] },
      { failing: [7] },
    );
    await failed.service.refresh(now);
    expect(failed.markUnlisted).not.toHaveBeenCalled();
  });

  it('shares one refresh between callers that ask at the same moment', async () => {
    const { service, getStaticData } = serviceOver({ 6: [season('season-7.2.0', true, 1)] });

    const [first, second] = await Promise.all([service.refresh(), service.refresh()]);

    expect(first).toBe(second);
    expect(getStaticData, 'expansion 6 and the empty 7, once each').toHaveBeenCalledTimes(2);

    await service.refresh();
    expect(getStaticData, 'a later refresh reads again').toHaveBeenCalledTimes(4);
  });
});
