import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RunLogger } from '../common/logging/run-context.js';
import { describeError } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { RaiderIoApiError } from '../raiderio/http/raiderio-api.error.js';
import {
  RAID_RANKING_PAGE_SIZE,
  RAID_RANKING_TOP,
  type RaidDifficulty,
  type RaidRankingRegion,
} from '../raiderio/raiderio.constants.js';
import { RaidingApi } from '../raiderio/raiding.api.js';
import type { RaidRanking } from '../raiderio/schemas/raid-rankings.schema.js';
import type { GuildDocument } from './entities/guild.entity.js';
import { GuildRepository } from './guild.repository.js';
import { RaidCatalogueService } from './raid-catalogue.service.js';
import { toGuildDocument, toRankedGuild } from './raid-rankings.mapper.js';
import { RaidRankingsRepository, type RaidRankingTarget } from './raid-rankings.repository.js';

/**
 * Boards that may fail with none succeeding in between before a run gives up.
 * A board fails alone often enough — upstream answers the odd 500 — but several
 * with no success among them is Raider.io being down, and the backfill is 450
 * boards long.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

export interface RaidRankingsRefresh {
  /** Boards read and stored. */
  boards: number;
  /** Boards that were due and could not be read; what was stored is kept. */
  failed: number;
  /** Boards left alone: a finished raid's, already read after it finished. */
  settled: number;
  /** Raids at least one board was stored for. */
  raids: number;
  /** Guild documents written or changed. */
  guilds: number;
  /** Why the run ended before every due board was tried, when it did. */
  stopped: string | null;
}

/** How a caller holds a run back; a run given none of it reads straight through. */
export interface RaidRankingsControl {
  /** Asked before each board; true ends the run there. For a shutdown. */
  shouldStop?: () => boolean;
  /**
   * Awaited before each board: resolves true once the board may be read, false
   * if it may not be for now, which ends the run. For yielding to
   * higher-priority jobs — it resolves at once while none is running, and is
   * free to wait while one is.
   */
  whenClear?: () => Promise<boolean>;
}

/** One ranking to read: a raid, on one board, at one difficulty. */
interface Board {
  raid: RaidRankingTarget;
  region: RaidRankingRegion;
  difficulty: RaidDifficulty;
}

/** When a raid closes everywhere, or null while any region's end is unknown. */
function closesAt(raid: RaidRankingTarget): Date | null {
  const ends = Object.values(raid.ends ?? {});
  if (ends.length === 0) return null;

  return new Date(Math.max(...ends.map((end) => end.getTime())));
}

/**
 * Keeps each raid's boards — the top hundred guilds at each difficulty, for
 * `world` and each region — and the guilds on them.
 *
 * **What is read when.** A raid that is still open is read every run: its race
 * is live. A raid that has closed is read until one read lands after it closed,
 * and never again by itself: its boards have settled, and thirty raids of
 * fifteen boards of five pages each would otherwise be 2,250 slow requests an
 * hour. The first run of a fresh database is that backfill, once.
 *
 * **Several boards at once, each read in pages and replaced whole**, guilds
 * first: the guilds a board names are written before the board is, so a
 * `guildId` on a raid always resolves. A board any page of which could not be
 * read keeps what it had and is due again next run — never half of the new one.
 * A board's own pages are read in order, since the first short one ends it.
 */
@Injectable()
export class RaidRankingsService {
  private readonly logger = new RunLogger(RaidRankingsService.name);
  private readonly regions: RaidRankingRegion[];
  private readonly difficulties: RaidDifficulty[];
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private inFlight: Promise<RaidRankingsRefresh> | null = null;

  constructor(
    config: ConfigService<Env, true>,
    private readonly api: RaidingApi,
    private readonly catalogue: RaidCatalogueService,
    private readonly repository: RaidRankingsRepository,
    private readonly guilds: GuildRepository,
  ) {
    this.regions = config.get('RAID_RANKINGS_REGIONS', { infer: true });
    this.difficulties = config.get('RAID_RANKINGS_DIFFICULTIES', { infer: true });
    this.concurrency = config.get('RAID_RANKINGS_CONCURRENCY', { infer: true });
    this.timeoutMs = config.get('RAID_RANKINGS_REQUEST_TIMEOUT_MS', { infer: true });
  }

  /**
   * Reads every board that is due. One run is shared between callers that ask
   * at once. `control` is consulted before each board, so a shutdown does not
   * have to wait out a backfill and a higher-priority job does not have to
   * share the process with one.
   */
  refreshDue(now = new Date(), control: RaidRankingsControl = {}): Promise<RaidRankingsRefresh> {
    if (!this.inFlight) {
      this.inFlight = this.run(now, control).finally(() => {
        this.inFlight = null;
      });
    }

    return this.inFlight;
  }

  /**
   * Reads every board of one raid now, whether or not it is due. Null when the
   * catalogue lists no such raid.
   */
  async refreshRaid(slug: string, now = new Date()): Promise<RaidRankingsRefresh | null> {
    const raid = await this.repository.target(slug);
    if (!raid) return null;

    return this.read([raid], now, {}, true);
  }

  private async run(now: Date, control: RaidRankingsControl): Promise<RaidRankingsRefresh> {
    // The boards hang off the catalogue's raids, and at boot both jobs tick at
    // once; this joins the walk in flight rather than finding no raids.
    try {
      await this.catalogue.refreshIfDue(now);
    } catch (error) {
      this.logger.warn(
        `Could not check the raid catalogue before reading rankings: ${describeError(error)}; ` +
          'reading the raids already stored',
      );
    }

    const raids = await this.repository.targets();
    const isOpen = (raid: RaidRankingTarget) => {
      const closes = closesAt(raid);

      return closes === null || closes > now;
    };

    // Open raids first: on a fresh database the live race should not wait
    // behind twenty-eight finished ones.
    return this.read(
      [...raids.filter(isOpen), ...raids.filter((raid) => !isOpen(raid))],
      now,
      control,
      false,
    );
  }

  private isDue(board: Board, now: Date): boolean {
    const readAt = board.raid.guildsUpdatedAt?.[board.region]?.[board.difficulty];
    if (!readAt) return true;

    const closes = closesAt(board.raid);
    if (closes === null || closes > now) return true;

    // Closed: due only until one read has landed after it closed.
    return readAt < closes;
  }

  private async read(
    raids: readonly RaidRankingTarget[],
    now: Date,
    control: RaidRankingsControl,
    force: boolean,
  ): Promise<RaidRankingsRefresh> {
    const result: RaidRankingsRefresh = {
      boards: 0,
      failed: 0,
      settled: 0,
      raids: 0,
      guilds: 0,
      stopped: null,
    };

    // Raid by raid, and within a raid the hardest difficulty first: the order
    // the boards are started in, and so what a run that ends early has read.
    const due: Board[] = [];
    for (const raid of raids) {
      for (const difficulty of this.difficulties) {
        for (const region of this.regions) {
          const board = { raid, region, difficulty };

          if (force || this.isDue(board, now)) due.push(board);
          else result.settled += 1;
        }
      }
    }

    const stored = new Set<number>();
    let next = 0;
    let failuresSinceSuccess = 0;

    const worker = async (): Promise<void> => {
      while (next < due.length && result.stopped === null) {
        if (control.shouldStop?.()) {
          result.stopped = 'the application is shutting down';
          return;
        }

        if (control.whenClear && !(await control.whenClear())) {
          result.stopped ??= 'higher-priority work is still running';
          return;
        }

        // The wait above let the other workers move on: look again.
        if (next >= due.length || result.stopped !== null) return;

        const board = due[next];
        next += 1;
        const label = `${board.region} ${board.difficulty} ranking of ${board.raid.slug}`;

        try {
          // Not `+= await`: that reads the total before the board is read, and
          // boards read at once would each overwrite the others' counts.
          const written = await this.readBoard(board, now);
          result.guilds += written;
          result.boards += 1;
          stored.add(board.raid.id);
          failuresSinceSuccess = 0;
        } catch (error) {
          result.failed += 1;

          if (error instanceof RaiderIoApiError && error.isBadRequest) {
            // Raider.io does not know the raid, region or difficulty: a fact
            // about this board, not a sign it is down, so it does not count
            // towards giving up.
            this.logger.warn(`Raider.io refused the ${label}: ${describeError(error)}`);
            continue;
          }

          this.logger.warn(
            `Could not read the ${label}: ${describeError(error)}; keeping what is stored`,
          );

          failuresSinceSuccess += 1;
          if (failuresSinceSuccess >= MAX_CONSECUTIVE_FAILURES && result.stopped === null) {
            result.stopped = `${failuresSinceSuccess} boards in a row could not be read`;
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(this.concurrency, due.length) }, () => worker()),
    );
    result.raids = stored.size;

    if (result.boards > 0 || result.failed > 0) {
      this.logger.log(
        `Raid rankings: ${result.boards} board(s) read across ${result.raids} raid(s), ` +
          `${result.guilds} guild write(s)` +
          (result.failed > 0 ? `; ${result.failed} board(s) failed` : '') +
          (result.stopped ? `; stopped early: ${result.stopped}` : ''),
      );
    }

    return result;
  }

  /** Reads and stores one board. Returns the guild writes it made. */
  private async readBoard({ raid, region, difficulty }: Board, now: Date): Promise<number> {
    const entries = await this.readPages(raid.slug, region, difficulty);

    const guilds = new Map<number, GuildDocument>();
    for (const entry of entries) guilds.set(entry.guild.id, toGuildDocument(entry, now));

    const board = entries.map((entry) => toRankedGuild(entry, raid.encounters));
    const unknown = new Set(
      board.flatMap((guild) =>
        [...guild.encountersPulled, ...guild.encountersDefeated]
          .filter((encounter) => encounter.encounterId === null)
          .map((encounter) => encounter.slug),
      ),
    );

    if (unknown.size > 0) {
      this.logger.warn(
        `The ${region} ${difficulty} ranking of ${raid.slug} names boss(es) the raid catalogue ` +
          `does not list: ${[...unknown].join(', ')}`,
      );
    }

    // Guilds before the board, so a guildId on a raid always resolves.
    const written = await this.guilds.upsertGuilds([...guilds.values()]);
    await this.repository.setBoard(raid.id, region, difficulty, board, now);

    return written;
  }

  /**
   * The board's pages in order, up to the top hundred, ending at the first
   * short page. A guild is kept once: the board can move between two pages, and
   * a guild that slipped a place would otherwise be listed on both.
   */
  private async readPages(
    slug: string,
    region: RaidRankingRegion,
    difficulty: RaidDifficulty,
  ): Promise<RaidRanking[]> {
    const entries: RaidRanking[] = [];
    const seen = new Set<number>();

    for (let page = 0; page * RAID_RANKING_PAGE_SIZE < RAID_RANKING_TOP; page += 1) {
      const served = await this.api.getRaidRankingsPage(
        slug,
        region,
        difficulty,
        page,
        this.timeoutMs,
      );

      for (const entry of served) {
        if (seen.has(entry.guild.id)) continue;
        seen.add(entry.guild.id);
        entries.push(entry);
      }

      if (served.length < RAID_RANKING_PAGE_SIZE) break;
    }

    return entries;
  }
}
