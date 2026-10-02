import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RaiderIoApiError } from '../raiderio/http/raiderio-api.error.js';
import type { RaidingApi } from '../raiderio/raiding.api.js';
import type { RaidRanking } from '../raiderio/schemas/raid-rankings.schema.js';
import type { GuildDocument } from './entities/guild.entity.js';
import type { GuildRepository } from './guild.repository.js';
import type { RaidCatalogueService } from './raid-catalogue.service.js';
import type { RaidRankingsRepository, RaidRankingTarget } from './raid-rankings.repository.js';
import { RaidRankingsService } from './raid-rankings.service.js';

const NOW = new Date('2026-10-02T12:00:00Z');
const OPEN_END = new Date('2030-01-01T00:00:00Z');
const CLOSED_END = new Date('2026-03-02T22:00:00Z');

function target(
  slug: string,
  ends: Date | null,
  readAt: Partial<Record<string, Date>> = {},
): RaidRankingTarget {
  return {
    id: slug.length,
    slug,
    ends: ends ? { us: new Date(ends.getTime() - 3_600_000), eu: ends } : {},
    encounters: [{ id: 11, slug: 'boss', name: 'Boss' }],
    // Read at the one difficulty these cases configure, unless a case says otherwise.
    guildsUpdatedAt: Object.fromEntries(
      Object.entries(readAt).map(([region, at]) => [region, { mythic: at }]),
    ),
  };
}

const entry = (rank: number, guildId = rank): RaidRanking => ({
  rank,
  guild: { id: guildId, name: `Guild ${guildId}` },
});

const page = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => entry(from + index));

const down = () => new RaiderIoApiError(503, 'https://raider.io/api/v1/raiding/raid-rankings', 'x');

function serviceOver(
  targets: RaidRankingTarget[],
  serve: (
    raid: string,
    region: string,
    pageNumber: number,
    difficulty: string,
  ) => RaidRanking[] = () => [],
  regions = ['world', 'us'],
  settings: { difficulties?: string[]; concurrency?: number } = {},
) {
  const getRaidRankingsPage = vi.fn<
    (
      raid: string,
      region: string,
      difficulty: string,
      page: number,
      timeoutMs?: number,
    ) => Promise<RaidRanking[]>
  >(async (raid, region, difficulty, pageNumber) => serve(raid, region, pageNumber, difficulty));
  const calls: string[] = [];
  const upsertGuilds = vi.fn(async (guilds: readonly GuildDocument[]) => {
    calls.push(`guilds:${guilds.length}`);

    return guilds.length;
  });
  const setBoard = vi.fn<
    (
      id: number,
      region: string,
      difficulty: string,
      board: unknown[],
      readAt: Date,
    ) => Promise<void>
  >(async (...[, region, , board]) => {
    calls.push(`board:${region}:${board.length}`);
  });
  const refreshIfDue = vi.fn(async () => ({ refreshed: false }));
  const env: Record<string, unknown> = {
    RAID_RANKINGS_REGIONS: regions,
    RAID_RANKINGS_DIFFICULTIES: settings.difficulties ?? ['mythic'],
    RAID_RANKINGS_CONCURRENCY: settings.concurrency ?? 1,
    RAID_RANKINGS_REQUEST_TIMEOUT_MS: 60_000,
  };

  return {
    service: new RaidRankingsService(
      { get: (key: string) => env[key] } as unknown as ConfigService<never, true>,
      { getRaidRankingsPage } as unknown as RaidingApi,
      { refreshIfDue } as unknown as RaidCatalogueService,
      {
        targets: vi.fn(async () => targets),
        target: vi.fn(async (slug: string) => targets.find((raid) => raid.slug === slug) ?? null),
        setBoard,
      } as unknown as RaidRankingsRepository,
      { upsertGuilds } as unknown as GuildRepository,
    ),
    getRaidRankingsPage,
    upsertGuilds,
    setBoard,
    refreshIfDue,
    calls,
    asked: () =>
      getRaidRankingsPage.mock.calls.map(([raid, region, , n]) => `${raid}/${region}/${n}`),
    difficulties: () =>
      getRaidRankingsPage.mock.calls.map(([, region, difficulty]) => `${difficulty}/${region}`),
  };
}

describe('RaidRankingsService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const quiet = () => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    return vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  };

  describe('what is due', () => {
    it('reads a board never read, whether the raid is open or closed', async () => {
      quiet();
      const { service, asked } = serviceOver([target('open', OPEN_END), target('old', CLOSED_END)]);

      const result = await service.refreshDue(NOW);

      expect(asked()).toEqual(['open/world/0', 'open/us/0', 'old/world/0', 'old/us/0']);
      expect(result).toMatchObject({ boards: 4, settled: 0, raids: 2 });
    });

    it('reads an open raid every run, however recently it was read', async () => {
      quiet();
      const { service, asked } = serviceOver([
        target('open', OPEN_END, { world: NOW, us: NOW }),
        // No end at all is a raid whose end is not known: open.
        target('undated', null, { world: NOW, us: NOW }),
      ]);

      await service.refreshDue(NOW);

      expect(asked()).toEqual(['open/world/0', 'open/us/0', 'undated/world/0', 'undated/us/0']);
    });

    it('leaves a closed raid alone once a read has landed after it closed', async () => {
      quiet();
      const after = new Date(CLOSED_END.getTime() + 1);
      const { service, asked } = serviceOver([
        target('old', CLOSED_END, { world: after, us: after }),
      ]);

      const result = await service.refreshDue(NOW);

      expect(asked()).toEqual([]);
      expect(result).toMatchObject({ boards: 0, settled: 2, raids: 0 });
    });

    it('reads a closed raid once more when its last read was before its last region closed', async () => {
      quiet();
      // After `us` closed, an hour before `eu` did: the raid was still open somewhere.
      const between = new Date(CLOSED_END.getTime() - 1_800_000);
      const { service, asked } = serviceOver([
        target('old', CLOSED_END, { world: between, us: new Date(CLOSED_END.getTime() + 1) }),
      ]);

      await service.refreshDue(NOW);

      expect(asked()).toEqual(['old/world/0']);
    });

    it('reads open raids before closed ones, in the order the repository gave within each', async () => {
      quiet();
      const { service, asked } = serviceOver(
        [target('old-a', CLOSED_END), target('open', OPEN_END), target('old-b', CLOSED_END)],
        () => [],
        ['eu'],
      );

      await service.refreshDue(NOW);

      expect(asked()).toEqual(['open/eu/0', 'old-a/eu/0', 'old-b/eu/0']);
    });
  });

  describe('reading a board', () => {
    it('asks page after page until a short one, with the timeout of its own', async () => {
      quiet();
      const { service, asked, getRaidRankingsPage, setBoard } = serviceOver(
        [target('open', OPEN_END)],
        (_raid, _region, n) => (n < 2 ? page(n * 20 + 1, 20) : page(41, 7)),
        ['eu'],
      );

      await service.refreshDue(NOW);

      expect(asked()).toEqual(['open/eu/0', 'open/eu/1', 'open/eu/2']);
      expect(getRaidRankingsPage.mock.calls[0][4]).toBe(60_000);
      expect(setBoard.mock.calls[0][3]).toHaveLength(47);
    });

    it('stops at the top hundred, without asking for a sixth page', async () => {
      quiet();
      const { service, asked, setBoard } = serviceOver(
        [target('open', OPEN_END)],
        (_raid, _region, n) => page(n * 20 + 1, 20),
        ['eu'],
      );

      await service.refreshDue(NOW);

      expect(asked()).toHaveLength(5);
      expect(setBoard.mock.calls[0][3]).toHaveLength(100);
    });

    it('keeps a guild once when the board moves between two pages', async () => {
      quiet();
      const { service, setBoard, upsertGuilds } = serviceOver(
        [target('open', OPEN_END)],
        // Guild 20 slipped a place between the requests: last of page 0, first of page 1.
        (_raid, _region, n) => (n === 0 ? page(1, 20) : [entry(21, 20), entry(22, 21)]),
        ['eu'],
      );

      await service.refreshDue(NOW);

      const board = setBoard.mock.calls[0][3] as { guildId: number; rank: number }[];
      expect(board).toHaveLength(21);
      expect(board.filter((guild) => guild.guildId === 20)).toEqual([
        expect.objectContaining({ rank: 20 }),
      ]);
      expect(upsertGuilds.mock.calls[0][0]).toHaveLength(21);
    });

    it('writes the guilds before the board that names them, stamped with the run', async () => {
      quiet();
      const { service, calls, setBoard, upsertGuilds } = serviceOver(
        [target('open', OPEN_END)],
        () => page(1, 3),
        ['eu'],
      );

      await service.refreshDue(NOW);

      expect(calls).toEqual(['guilds:3', 'board:eu:3']);
      expect(setBoard.mock.calls[0][4]).toBe(NOW);
      expect(upsertGuilds.mock.calls[0][0][0]).toMatchObject({ id: 1, updatedAt: NOW });
    });

    it('stores an empty board as read', async () => {
      quiet();
      const { service, setBoard } = serviceOver([target('open', OPEN_END)], () => [], ['kr']);

      const result = await service.refreshDue(NOW);

      expect(setBoard).toHaveBeenCalledWith(4, 'kr', 'mythic', [], NOW);
      expect(result).toMatchObject({ boards: 1, guilds: 0 });
    });

    it('warns once per board about bosses the raid does not list', async () => {
      const warn = quiet();
      const { service } = serviceOver(
        [target('open', OPEN_END)],
        () => [
          { ...entry(1), encountersPulled: [{ slug: 'boss' }, { slug: 'ghost' }] },
          { ...entry(2), encountersDefeated: [{ slug: 'ghost' }, { slug: 'phantom' }] },
        ],
        ['eu'],
      );

      await service.refreshDue(NOW);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toMatch(
        /eu mythic ranking of open names boss\(es\).*: ghost, phantom$/,
      );
    });
  });

  describe('failures', () => {
    it('stores nothing of a board when a later page fails, and reads the next board', async () => {
      const warn = quiet();
      const { service, calls } = serviceOver([target('open', OPEN_END)], (_raid, region, n) => {
        if (region === 'world' && n === 1) throw down();

        return region === 'world' ? page(1, 20) : page(1, 2);
      });

      const result = await service.refreshDue(NOW);

      expect(calls).toEqual(['guilds:2', 'board:us:2']);
      expect(result).toMatchObject({ boards: 1, failed: 1, raids: 1, stopped: null });
      expect(warn.mock.calls[0][0]).toMatch(
        /^Could not read the world mythic ranking of open: .*; keeping what is stored$/,
      );
    });

    it('gives up after three boards in a row, and not before', async () => {
      quiet();
      let failing = 2;
      const { service, asked } = serviceOver(
        [target('a', OPEN_END), target('b', OPEN_END), target('c', OPEN_END)],
        () => {
          if (failing > 0) {
            failing -= 1;
            throw down();
          }

          return [];
        },
      );

      // Two failures, then a success: the count starts again.
      expect(await service.refreshDue(NOW)).toMatchObject({ boards: 4, failed: 2, stopped: null });

      failing = 100;
      const result = await service.refreshDue(NOW);
      expect(result).toMatchObject({
        boards: 0,
        failed: 3,
        stopped: '3 boards in a row could not be read',
      });
      expect(asked().slice(6)).toEqual(['a/world/0', 'a/us/0', 'b/world/0']);
    });

    it('does not count a 400 towards giving up', async () => {
      const warn = quiet();
      const { service, asked } = serviceOver([target('a', OPEN_END), target('b', OPEN_END)], () => {
        throw new RaiderIoApiError(400, 'https://raider.io/x', 'Invalid request query input');
      });

      const result = await service.refreshDue(NOW);

      expect(asked()).toHaveLength(4);
      expect(result).toMatchObject({ failed: 4, stopped: null });
      expect(warn.mock.calls[0][0]).toMatch(/^Raider\.io refused the world mythic ranking of a: /);
    });

    it('reads the raids already stored when the catalogue check fails', async () => {
      const warn = quiet();
      const { service, refreshIfDue, asked } = serviceOver([target('open', OPEN_END)]);
      refreshIfDue.mockRejectedValueOnce(new Error('mongo is gone'));

      await service.refreshDue(NOW);

      expect(asked()).toEqual(['open/world/0', 'open/us/0']);
      expect(warn.mock.calls[0][0]).toMatch(/Could not check the raid catalogue.*mongo is gone/);
    });
  });

  describe('runs', () => {
    it('checks the catalogue first, so a boot with no raids yet finds them', async () => {
      quiet();
      const { service, refreshIfDue, getRaidRankingsPage } = serviceOver([
        target('open', OPEN_END),
      ]);

      await service.refreshDue(NOW);

      expect(refreshIfDue).toHaveBeenCalledWith(NOW);
      expect(refreshIfDue.mock.invocationCallOrder[0]).toBeLessThan(
        getRaidRankingsPage.mock.invocationCallOrder[0],
      );
    });

    it('shares one run between callers that ask at once', async () => {
      quiet();
      const { service, asked } = serviceOver([target('open', OPEN_END)]);

      const [first, second] = await Promise.all([service.refreshDue(NOW), service.refreshDue(NOW)]);

      expect(first).toBe(second);
      expect(asked()).toHaveLength(2);
    });

    it('stops between boards when asked to, saying why', async () => {
      quiet();
      const { service, asked } = serviceOver([target('a', OPEN_END), target('b', OPEN_END)]);
      let boards = 0;

      const result = await service.refreshDue(NOW, { shouldStop: () => (boards += 1) > 1 });

      expect(asked()).toEqual(['a/world/0']);
      expect(result.stopped).toBe('the application is shutting down');
    });

    it('says nothing when nothing was due', async () => {
      const after = new Date(CLOSED_END.getTime() + 1);
      const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
      const { service } = serviceOver([target('old', CLOSED_END, { world: after, us: after })]);

      await service.refreshDue(NOW);

      expect(log).not.toHaveBeenCalled();
    });
  });

  describe('difficulties and boards at once', () => {
    it('reads each difficulty as a board of its own, the first configured first', async () => {
      quiet();
      const { service, difficulties, setBoard } = serviceOver(
        [target('open', OPEN_END)],
        (_raid, _region, _page, difficulty) => (difficulty === 'heroic' ? page(1, 2) : []),
        ['world', 'us'],
        { difficulties: ['mythic', 'heroic', 'normal'] },
      );

      const result = await service.refreshDue(NOW);

      expect(difficulties()).toEqual([
        'mythic/world',
        'mythic/us',
        'heroic/world',
        'heroic/us',
        'normal/world',
        'normal/us',
      ]);
      expect(result).toMatchObject({ boards: 6, raids: 1 });
      expect(
        setBoard.mock.calls.map(([, region, difficulty, board]) => [
          region,
          difficulty,
          board.length,
        ]),
      ).toEqual([
        ['world', 'mythic', 0],
        ['us', 'mythic', 0],
        ['world', 'heroic', 2],
        ['us', 'heroic', 2],
        ['world', 'normal', 0],
        ['us', 'normal', 0],
      ]);
    });

    it('judges each difficulty of a closed raid by its own last read', async () => {
      quiet();
      const after = new Date(CLOSED_END.getTime() + 1);
      const raid = target('old', CLOSED_END);
      raid.guildsUpdatedAt = { world: { mythic: after, normal: new Date(0) } };
      const { service, difficulties } = serviceOver([raid], () => [], ['world'], {
        difficulties: ['mythic', 'heroic', 'normal'],
      });

      const result = await service.refreshDue(NOW);

      // Mythic is settled; Heroic was never read; Normal was read before it closed.
      expect(difficulties()).toEqual(['heroic/world', 'normal/world']);
      expect(result).toMatchObject({ boards: 2, settled: 1 });
    });

    it('reads several boards at once, up to the limit, and each board own pages in order', async () => {
      quiet();
      let inFlight = 0;
      let peak = 0;
      const pages: Record<string, number[]> = {};
      const { service, getRaidRankingsPage } = serviceOver(
        [target('one', OPEN_END), target('other', OPEN_END)],
        () => [],
        ['world', 'us', 'eu', 'kr'],
        { concurrency: 3 },
      );
      getRaidRankingsPage.mockImplementation(async (raid, region, _difficulty, n) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        (pages[`${raid}/${region}`] ??= []).push(n);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;

        return n < 2 ? page(n * 20 + 1, 20) : [];
      });

      const result = await service.refreshDue(NOW);

      expect(peak).toBe(3);
      // Counted after each board lands, not from a total read before it started.
      expect(result).toMatchObject({ boards: 8, raids: 2, failed: 0, guilds: 8 * 40 });
      for (const read of Object.values(pages)) expect(read).toEqual([0, 1, 2]);
    });

    it('starts no new board once it has given up, whatever is still in flight', async () => {
      quiet();
      const { service, asked } = serviceOver(
        Array.from({ length: 10 }, (_, index) => target(`raid-${index}`, OPEN_END)),
        () => {
          throw down();
        },
        ['world'],
        { concurrency: 4 },
      );

      const result = await service.refreshDue(NOW);

      expect(result.stopped).toMatch(/boards in a row could not be read/);
      expect(asked().length).toBeLessThanOrEqual(6);
      expect(result.failed).toBe(asked().length);
    });
  });

  describe('yielding to higher-priority work', () => {
    it('asks before every board whether it may go on, and reads each once it may', async () => {
      quiet();
      const { service, asked } = serviceOver([target('a', OPEN_END), target('bb', OPEN_END)]);
      const order: string[] = [];
      const whenClear = vi.fn(async () => {
        order.push(`clear before ${asked().length}`);

        return true;
      });

      const result = await service.refreshDue(NOW, { whenClear });

      expect(order).toEqual([
        'clear before 0',
        'clear before 1',
        'clear before 2',
        'clear before 3',
      ]);
      expect(result).toMatchObject({ boards: 4, stopped: null });
    });

    it('holds the next board while the wait lasts, and carries on from where it was', async () => {
      quiet();
      const { service, asked } = serviceOver([target('a', OPEN_END), target('bb', OPEN_END)]);
      let release!: (clear: boolean) => void;
      let calls = 0;
      const whenClear = () => {
        calls += 1;

        // The second board finds something above it running.
        return calls === 2
          ? new Promise<boolean>((resolve) => (release = resolve))
          : Promise.resolve(true);
      };

      const running = service.refreshDue(NOW, { whenClear });
      await vi.waitFor(() => expect(calls).toBe(2));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(asked(), 'nothing is asked for while it waits').toEqual(['a/world/0']);

      release(true);

      expect(await running).toMatchObject({ boards: 4, stopped: null });
      expect(asked()).toEqual(['a/world/0', 'a/us/0', 'bb/world/0', 'bb/us/0']);
    });

    it('ends the run when the wait runs out, leaving the rest due', async () => {
      quiet();
      const { service, asked } = serviceOver([target('a', OPEN_END), target('bb', OPEN_END)]);
      let calls = 0;

      const result = await service.refreshDue(NOW, { whenClear: async () => (calls += 1) < 3 });

      expect(asked()).toEqual(['a/world/0', 'a/us/0']);
      expect(result).toMatchObject({
        boards: 2,
        failed: 0,
        stopped: 'higher-priority work is still running',
      });
    });

    it('does not hold back a run asked for by hand', async () => {
      quiet();
      const { service, asked } = serviceOver([target('a', OPEN_END)]);

      // `refreshRaid` takes no control at all: an operator asked for it now.
      await service.refreshRaid('a', NOW);

      expect(asked()).toEqual(['a/world/0', 'a/us/0']);
    });
  });

  describe('refreshRaid', () => {
    it('re-reads every board of a settled raid, and skips the catalogue check', async () => {
      quiet();
      const after = new Date(CLOSED_END.getTime() + 1);
      const { service, asked, refreshIfDue } = serviceOver([
        target('old', CLOSED_END, { world: after, us: after }),
      ]);

      const result = await service.refreshRaid('old', NOW);

      expect(asked()).toEqual(['old/world/0', 'old/us/0']);
      expect(result).toMatchObject({ boards: 2, settled: 0, raids: 1 });
      expect(refreshIfDue).not.toHaveBeenCalled();
    });

    it('answers null for a raid the catalogue does not list', async () => {
      const { service, asked } = serviceOver([target('old', CLOSED_END)]);

      expect(await service.refreshRaid('no-such-raid', NOW)).toBeNull();
      expect(asked()).toEqual([]);
    });
  });
});
