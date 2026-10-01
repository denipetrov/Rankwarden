import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RaiderIoApiError } from '../raiderio/http/raiderio-api.error.js';
import type { RaidingApi } from '../raiderio/raiding.api.js';
import type { RaidStaticData, StaticRaid } from '../raiderio/schemas/raid-static-data.schema.js';
import type { RaidCatalogueRepository } from './raid-catalogue.repository.js';
import { RaidCatalogueService } from './raid-catalogue.service.js';

function raid(id: number, slug: string): StaticRaid {
  return {
    id,
    slug,
    name: slug,
    starts: { us: '2024-01-01T00:00:00Z' },
    ends: { us: '2024-06-01T00:00:00Z' },
    encounters: [{ id: id * 10, slug: `${slug}-boss`, name: 'Boss' }],
  };
}

const unsupported = (expansionId: number) =>
  new RaiderIoApiError(
    400,
    `https://raider.io/api/v1/raiding/static-data?expansion_id=${expansionId}`,
    'Requested unsupported expansion_id',
  );

/**
 * A service over a fake endpoint. Expansions not listed answer 400, as upstream
 * does; `failing` ones answer 503; `empty` ones answer 200 with no raids.
 */
function serviceOver(
  byExpansion: Record<number, StaticRaid[]>,
  options: { failing?: number[]; empty?: number[]; updatedAt?: Date | null; first?: number } = {},
) {
  const getStaticData = vi.fn(async (expansionId: number): Promise<RaidStaticData> => {
    if (options.failing?.includes(expansionId)) {
      throw new RaiderIoApiError(503, 'https://raider.io/api/v1/raiding/static-data', 'down');
    }
    if (options.empty?.includes(expansionId)) return { raids: [] };
    if (!byExpansion[expansionId]) throw unsupported(expansionId);

    return { raids: byExpansion[expansionId] };
  });
  const upsertRaids = vi.fn(async (raids: unknown[]) => raids.length);
  const markUnlisted = vi.fn(async () => 0);
  const catalogueUpdatedAt = vi.fn(async () => options.updatedAt ?? null);
  const env: Record<string, unknown> = {
    RAID_CATALOGUE_FIRST_EXPANSION: options.first ?? 6,
    RAID_CATALOGUE_TTL_MS: 86_400_000,
  };

  return {
    service: new RaidCatalogueService(
      { get: (key: string) => env[key] } as unknown as ConfigService<never, true>,
      { getStaticData } as unknown as RaidingApi,
      { upsertRaids, markUnlisted, catalogueUpdatedAt } as unknown as RaidCatalogueRepository,
    ),
    getStaticData,
    upsertRaids,
    markUnlisted,
  };
}

describe('RaidCatalogueService.refresh', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('walks expansions upward and ends on the 400 for an unsupported one', async () => {
    const { service, getStaticData, upsertRaids } = serviceOver({
      6: [raid(8026, 'the-emerald-nightmare'), raid(8025, 'the-nighthold')],
      7: [raid(9389, 'uldir')],
    });

    const result = await service.refresh();

    expect(result).toMatchObject({ refreshed: true, expansions: [6, 7], raids: 3, reason: null });
    // 6, 7, and the 8 that ended the list. The 400 is the end, not a failure.
    expect(getStaticData.mock.calls.map(([id]) => id)).toEqual([6, 7, 8]);
    expect(upsertRaids).toHaveBeenCalledTimes(2);
  });

  it('stores each raid under the expansion that listed it', async () => {
    const { service, upsertRaids } = serviceOver({ 6: [raid(1, 'a')], 7: [raid(2, 'b')] });

    await service.refresh();

    const stored = upsertRaids.mock.calls.flatMap(([raids]) =>
      (raids as { id: number; expansionId: number }[]).map((item) => [item.id, item.expansionId]),
    );
    expect(stored).toEqual([
      [1, 6],
      [2, 7],
    ]);
  });

  /**
   * "No longer listed" is only known once the walk reached the end of the
   * list. A walk that stopped on a failure has not seen the later expansions,
   * and marking their raids unlisted would take them for gone.
   */
  it('marks unlisted raids only after a walk that reached the end', async () => {
    const now = new Date('2026-10-01T12:00:00Z');
    const complete = serviceOver({ 6: [raid(1, 'a')] });
    await complete.service.refresh(now);
    expect(complete.markUnlisted).toHaveBeenCalledWith(now);

    const failed = serviceOver({ 6: [raid(1, 'a')], 8: [raid(3, 'c')] }, { failing: [7] });
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const result = await failed.service.refresh(now);

    expect(result.expansions).toEqual([6]);
    expect(
      failed.getStaticData.mock.calls.map(([id]) => id),
      'never asks for 8',
    ).toEqual([6, 7]);
    expect(failed.markUnlisted).not.toHaveBeenCalled();
  });

  it('treats a first expansion that is itself unsupported as a misconfiguration', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, markUnlisted } = serviceOver({ 6: [raid(1, 'a')] }, { first: 5 });

    const result = await service.refresh();

    expect(result).toMatchObject({ refreshed: false, expansions: [], raids: 0 });
    // Nothing was listed, but that says the setting is wrong, not that every
    // raid is gone.
    expect(markUnlisted).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([message]) => String(message))).toContainEqual(
      expect.stringMatching(/lists no raids for expansion 5; check RAID_CATALOGUE_FIRST_EXPANSION/),
    );
  });

  it('also ends on an expansion that answers with no raids at all', async () => {
    const { service, getStaticData, markUnlisted } = serviceOver(
      { 6: [raid(1, 'a')], 8: [raid(3, 'c')] },
      { empty: [7] },
    );

    const result = await service.refresh();

    expect(result.expansions).toEqual([6]);
    expect(getStaticData.mock.calls.map(([id]) => id)).toEqual([6, 7]);
    expect(markUnlisted).toHaveBeenCalledTimes(1);
  });

  it('shares one walk between callers that ask at the same moment', async () => {
    const { service, getStaticData } = serviceOver({ 6: [raid(1, 'a')] });

    const [first, second] = await Promise.all([service.refresh(), service.refresh()]);

    expect(first).toBe(second);
    expect(getStaticData).toHaveBeenCalledTimes(2);
  });
});

describe('RaidCatalogueService.refreshIfDue', () => {
  const now = new Date('2026-10-01T12:00:00Z');
  const day = 86_400_000;

  it('reads an empty catalogue whatever the TTL', async () => {
    const { service } = serviceOver({ 6: [raid(1, 'a')] });

    expect((await service.refreshIfDue(now)).refreshed).toBe(true);
  });

  it('makes no request while the oldest stamp is inside the TTL', async () => {
    const { service, getStaticData } = serviceOver(
      { 6: [raid(1, 'a')] },
      { updatedAt: new Date(now.getTime() - day + 60_000) },
    );

    const result = await service.refreshIfDue(now);

    expect(result.refreshed).toBe(false);
    expect(result.reason).toMatch(/raid catalogue is fresh/);
    expect(getStaticData).not.toHaveBeenCalled();
  });

  it('walks once the oldest stamp is past the TTL', async () => {
    const { service } = serviceOver(
      { 6: [raid(1, 'a')] },
      { updatedAt: new Date(now.getTime() - day - 1) },
    );

    expect((await service.refreshIfDue(now)).refreshed).toBe(true);
  });
});
