import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RATING_FAMILIES, type Region } from '../blizzard/blizzard.constants.js';
import { MongoService } from '../database/mongo.service.js';
import type { Env } from '../config/env.schema.js';
import {
  ARCHIVE_SEASONS_COLLECTION,
  type ArchiveSeasonDocument,
} from '../archive/entities/archive.entity.js';
import { CHARACTERS_COLLECTION } from '../leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../leaderboard/entities/rating.entity.js';
import { SPEC_REPRESENTATION_COLLECTION } from '../representation/entities/spec-representation.entity.js';
import { SeasonStateRepository } from './season-state.repository.js';
import type { SeasonStateDocument } from './entities/season-state.entity.js';

export interface PurgeCandidate {
  region: Region;
  seasonId: number;
  /** Whether the archive holds this season in full. */
  archived: boolean;
}

export interface SeasonTransitionPlan {
  /** Whether the gate is open; candidates are only purged when it is. */
  permitted: boolean;
  /** Why nothing will happen, or null when something will. */
  reason: string | null;
  newestSeason: number | null;
  /** When the newest season began in the first region to reach it. */
  transitionAt: string | null;
  current: Record<string, number>;
  candidates: PurgeCandidate[];
  /** Candidates held back only by the archive interlock. */
  blockedByArchive: PurgeCandidate[];
  dryRun: boolean;
  requireArchive: boolean;
}

export interface PurgeOutcome {
  region: Region;
  seasonId: number;
  removed: Record<string, number>;
  dryRun: boolean;
}

/**
 * Retires a finished season from the live collections once the next one begins.
 *
 * A finished season stays live and readable until the new season actually
 * starts, so the boards do not empty during the gap between one season ending
 * and the next beginning. The trigger is the earliest new-season start across
 * regions; the delete is scoped per region, because regions stagger by up to 32
 * hours and deleting on the earliest start would remove a trailing region's
 * live board while it is still playing — its next sweep would rewrite it and
 * the next tick would remove it again, thrashing hourly with a hole in the
 * board each time.
 *
 * Collection names are imported as constants rather than reached through their
 * owning repositories: `ArchiveModule` already imports `SeasonModule`, so
 * injecting `ArchiveRepository` here would close a module cycle.
 */
@Injectable()
export class SeasonTransitionService {
  private readonly logger = new Logger(SeasonTransitionService.name);
  private readonly regions: Region[];
  private readonly requireArchive: boolean;
  private readonly dryRun: boolean;

  constructor(
    config: ConfigService<Env, true>,
    private readonly mongo: MongoService,
    private readonly state: SeasonStateRepository,
  ) {
    this.regions = config.get('BLIZZARD_REGIONS', { infer: true });
    this.requireArchive = config.get('SEASON_PURGE_REQUIRE_ARCHIVE', { infer: true });
    this.dryRun = config.get('SEASON_PURGE_DRY_RUN', { infer: true });
  }

  get isDryRun(): boolean {
    return this.dryRun;
  }

  /**
   * Decides whether anything should be retired, and what. Read-only, so it is
   * safe to expose on the health endpoint and watch across a real season
   * boundary before anything is allowed to delete.
   */
  async plan(now = new Date()): Promise<SeasonTransitionPlan> {
    const observed = new Map<Region, SeasonStateDocument>(
      (await this.state.loadAll()).map((entry) => [entry.region, entry]),
    );
    const current = Object.fromEntries(
      [...observed].map(([region, entry]) => [region, entry.seasonId]),
    );

    const base = {
      newestSeason: null,
      transitionAt: null,
      current,
      candidates: [],
      blockedByArchive: [],
      dryRun: this.dryRun,
      requireArchive: this.requireArchive,
    } satisfies Omit<SeasonTransitionPlan, 'permitted' | 'reason'>;

    // One region failing at boot must never be mistaken for a rollover.
    const unobserved = this.regions.filter((region) => !observed.has(region));
    if (unobserved.length > 0) {
      return {
        ...base,
        permitted: false,
        reason: `region ${unobserved.join(', ')} not yet observed`,
      };
    }

    const states = this.regions
      .map((region) => observed.get(region))
      .filter((entry): entry is SeasonStateDocument => entry !== undefined);
    const newest = Math.max(...states.map((entry) => entry.seasonId));
    const transitionAt = new Date(
      Math.min(
        ...states
          .filter((entry) => entry.seasonId === newest)
          .map((entry) => entry.startsAt.getTime()),
      ),
    );

    // Guards against a future-dated season record opening the gate early.
    if (now < transitionAt) {
      return {
        ...base,
        permitted: false,
        newestSeason: newest,
        transitionAt: transitionAt.toISOString(),
        reason: `season ${newest} starts at ${transitionAt.toISOString()}`,
      };
    }

    const purged = await this.state.purgedPairs();
    const archived = this.requireArchive ? await this.completedArchives() : null;
    const candidates: PurgeCandidate[] = [];
    const blockedByArchive: PurgeCandidate[] = [];

    for (const entry of states) {
      const stale = (
        await this.mongo
          .collection(CHARACTERS_COLLECTION)
          .distinct('seasonId', { region: entry.region })
      )
        .filter((seasonId): seasonId is number => typeof seasonId === 'number')
        // Scoped per region, so a trailing region keeps its own live season.
        .filter((seasonId) => seasonId < entry.seasonId)
        .filter((seasonId) => !purged.has(`${seasonId}:${entry.region}`))
        .sort((left, right) => left - right);

      for (const seasonId of stale) {
        const isArchived = archived?.has(`${seasonId}:${entry.region}`) ?? true;
        const candidate: PurgeCandidate = { region: entry.region, seasonId, archived: isArchived };

        // After a purge the archive is the only surviving copy of the season.
        if (isArchived) candidates.push(candidate);
        else blockedByArchive.push(candidate);
      }
    }

    return {
      ...base,
      permitted: true,
      reason: candidates.length === 0 ? 'nothing to retire' : null,
      newestSeason: newest,
      transitionAt: transitionAt.toISOString(),
      candidates,
      blockedByArchive,
    };
  }

  /** Plans, then executes. The entry point for the scheduler and for /admin. */
  async run(now = new Date()): Promise<{ plan: SeasonTransitionPlan; purged: PurgeOutcome[] }> {
    const plan = await this.plan(now);

    if (!plan.permitted) {
      this.logger.debug(`Season purge not permitted: ${plan.reason}`);
      return { plan, purged: [] };
    }

    if (plan.blockedByArchive.length > 0) {
      this.logger.warn(
        `Holding back ${plan.blockedByArchive.length} season(s) with no complete archive: ` +
          plan.blockedByArchive.map((entry) => `${entry.seasonId}/${entry.region}`).join(', '),
      );
    }

    const purged: PurgeOutcome[] = [];

    for (const candidate of plan.candidates) {
      purged.push(await this.purge(candidate, plan.newestSeason ?? candidate.seasonId));
    }

    return { plan, purged };
  }

  /**
   * Removes one season in one region from the live collections.
   *
   * Rating rows go before characters, so the "no orphan rating rows" invariant
   * holds at every intermediate moment rather than only at the end. Reversing
   * the two leaves a window in which a crash produces exactly the orphan state
   * the sweep's `removeOrphans` exists to clean up.
   */
  async purge(candidate: PurgeCandidate, triggeredBy: number): Promise<PurgeOutcome> {
    const { seasonId, region } = candidate;
    const filter = { seasonId, region };
    const collections = [
      ...RATING_FAMILIES.map((family) => RATING_COLLECTIONS[family]),
      CHARACTERS_COLLECTION,
      SPEC_REPRESENTATION_COLLECTION,
    ];
    const removed: Record<string, number> = {};

    for (const name of collections) {
      removed[name] = this.dryRun
        ? await this.mongo.collection(name).countDocuments(filter)
        : (await this.mongo.collection(name).deleteMany(filter)).deletedCount;
    }

    this.logger.warn(
      `${this.dryRun ? '[dry run] Would retire' : 'Retired'} season ${seasonId} ${region}: ` +
        (describeCounts(removed) || 'nothing stored'),
    );

    await this.state.recordPurge({
      seasonId,
      region,
      purgedAt: new Date(),
      removed,
      triggeredBy,
      dryRun: this.dryRun,
    });

    return { region, seasonId, removed, dryRun: this.dryRun };
  }

  /** Season/region pairs the archive holds with nothing outstanding. */
  private async completedArchives(): Promise<Set<string>> {
    const done = await this.mongo
      .collection<ArchiveSeasonDocument>(ARCHIVE_SEASONS_COLLECTION)
      .find({ failedBrackets: { $size: 0 } }, { projection: { seasonId: 1, region: 1 } })
      .toArray();

    return new Set(done.map((entry) => `${entry.seasonId}:${entry.region}`));
  }
}

function describeCounts(removed: Record<string, number>): string {
  return Object.entries(removed)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name}`)
    .join(', ');
}
