import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import type { Env } from '../config/env.schema.js';
import { MongoService } from '../database/mongo.service.js';
import { MPLUS_CHARACTERS_COLLECTION } from '../mplus/entities/mplus-character.entity.js';
import { MPLUS_RUNS_COLLECTION } from '../mplus/entities/mplus-run.entity.js';
import type { RaiderIoRegion } from '../raiderio/raiderio.constants.js';
import type { MplusSeasonDocument } from './entities/mplus-season.entity.js';
import { isArchiveSettled, startIn } from './mplus-catalogue.mapper.js';
import { MplusCatalogueRepository } from './mplus-catalogue.repository.js';
import { MplusSeasonStateRepository } from './mplus-season-state.repository.js';
import { resolveRegions, type ResolvedMplusSeason } from './mplus-season.service.js';

export interface MplusPurgeCandidate {
  region: RaiderIoRegion;
  season: string;
  /** Whether the archive holds this region's share of the season, or refused the season. */
  archived: boolean;
  /** The marker's status, or null when the archive has not tried the season. */
  archiveStatus: string | null;
}

export interface MplusSeasonTransitionPlan {
  /** Whether the gate is open; candidates are only purged when it is. */
  permitted: boolean;
  /** Why nothing will happen, or null when something will. */
  reason: string | null;
  /** The season current in each region, or null where none has opened. */
  current: Record<string, string | null>;
  candidates: MplusPurgeCandidate[];
  /** Candidates held back only by the archive interlock. */
  blockedByArchive: MplusPurgeCandidate[];
  dryRun: boolean;
  requireArchive: boolean;
}

export interface MplusPurgeOutcome {
  region: RaiderIoRegion;
  season: string;
  removed: Record<string, number>;
  dryRun: boolean;
}

/**
 * The live seasons stored in a region that the current one has superseded.
 *
 * A stored season is superseded when it is not the current one and opened
 * before it. One the catalogue does not list is superseded too: the live pass
 * only ever writes a catalogued season, so an unlisted slug is a leftover — a
 * season pinned by the configuration this replaced, say — and never current.
 * A stored season that opened *after* the current one is left alone; nothing
 * about it says it is finished.
 */
export function supersededSeasons(
  stored: readonly string[],
  current: Pick<ResolvedMplusSeason, 'slug' | 'startsAt'>,
  catalogue: ReadonlyMap<string, MplusSeasonDocument>,
  region: string,
): string[] {
  return stored
    .filter((season) => season !== current.slug)
    .filter((season) => {
      const entry = catalogue.get(season);
      if (!entry) return true;

      const startedAt = startIn(entry, region);

      return startedAt !== null && startedAt.getTime() < current.startsAt.getTime();
    })
    .sort();
}

/**
 * Retires a superseded Mythic+ season from the live collections, region by
 * region, once the next season has opened there. The counterpart of
 * `SeasonTransitionService`, with the same three rules.
 *
 * **Not when the old season ends.** A finished season stays current, and the
 * live pass keeps ingesting it, until its successor actually opens in the
 * region — so the board does not empty in the gap between seasons.
 *
 * **Per region.** Regions stagger by up to 32 hours. Retiring a season
 * everywhere the moment the first region rolled would delete a board the
 * trailing regions were still playing, and their next pass would write it back.
 *
 * **Only once archived** (`MPLUS_PURGE_REQUIRE_ARCHIVE`, on by default). After
 * the purge the archive is the only record of the season. Since the archive
 * waits for a season to end in *every* region, the first region to roll over
 * keeps its old board for as long as the last region is still playing it, plus
 * however long the archive takes — hours, and harmless, because every read is
 * scoped by season.
 *
 * Collection names are imported as constants rather than reached through
 * `MplusRepository`, because `MplusModule` imports this module; injecting its
 * repository here would close a module cycle — the arrangement the PvP
 * transition makes for the same reason.
 */
@Injectable()
export class MplusSeasonTransitionService {
  private readonly logger = new Logger(MplusSeasonTransitionService.name);
  private readonly regions: RaiderIoRegion[];
  private readonly requireArchive: boolean;
  private readonly dryRun: boolean;

  constructor(
    config: ConfigService<Env, true>,
    private readonly mongo: MongoService,
    private readonly catalogue: MplusCatalogueRepository,
    private readonly state: MplusSeasonStateRepository,
    private readonly coordinator: IngestionCoordinator,
  ) {
    this.regions = config.get('RAIDERIO_REGIONS', { infer: true });
    this.requireArchive = config.get('MPLUS_PURGE_REQUIRE_ARCHIVE', { infer: true });
    this.dryRun = config.get('MPLUS_PURGE_DRY_RUN', { infer: true });
  }

  get isDryRun(): boolean {
    return this.dryRun;
  }

  get requiresArchive(): boolean {
    return this.requireArchive;
  }

  /**
   * Decides what should be retired. Read-only, so it is safe on the health
   * endpoint and can be watched across a real season boundary.
   */
  async plan(now = new Date()): Promise<MplusSeasonTransitionPlan> {
    const base = {
      current: {},
      candidates: [],
      blockedByArchive: [],
      dryRun: this.dryRun,
      requireArchive: this.requireArchive,
    } satisfies Omit<MplusSeasonTransitionPlan, 'permitted' | 'reason'>;

    const seasons = await this.catalogue.allSeasons();

    // With no catalogue there is no current season anywhere, and every stored
    // season would read as a leftover.
    if (seasons.length === 0) {
      return { ...base, permitted: false, reason: 'the Mythic+ season catalogue is empty' };
    }

    // A pass that started before the season rolled is still writing the old
    // season. Retiring it underneath the pass would leave whatever it wrote
    // afterwards behind; the scheduler waits for the pass instead.
    if (this.coordinator.isMplusActive) {
      return { ...base, permitted: false, reason: 'a Mythic+ pass is running' };
    }

    const bySlug = new Map(seasons.map((season) => [season.slug, season]));
    const resolution = resolveRegions(seasons, this.regions, now);
    const current = Object.fromEntries(
      this.regions.map((region) => [region, resolution.get(region)?.slug ?? null]),
    );
    const candidates: MplusPurgeCandidate[] = [];
    const blockedByArchive: MplusPurgeCandidate[] = [];

    for (const region of this.regions) {
      const season = resolution.get(region);
      // No season has opened here: nothing is current, so nothing is superseded.
      if (!season) continue;

      const stale = supersededSeasons(await this.storedSeasons(region), season, bySlug, region);

      for (const slug of stale) {
        const entry = bySlug.get(slug);
        const candidate: MplusPurgeCandidate = {
          region,
          season: slug,
          archived: entry ? isArchiveSettled(entry, region) : false,
          archiveStatus: entry?.archive?.status ?? null,
        };

        // The interlock waits for the archive to hold a season. A season the
        // catalogue does not list can never be held — the archive reads only
        // what the catalogue lists — so waiting would be for ever; it is
        // retired like any other superseded season.
        if (!entry || candidate.archived || !this.requireArchive) candidates.push(candidate);
        else blockedByArchive.push(candidate);
      }
    }

    return {
      ...base,
      permitted: true,
      reason: candidates.length === 0 ? 'nothing to retire' : null,
      current,
      candidates,
      blockedByArchive,
    };
  }

  /** Plans, then executes. The entry point for the scheduler and for /admin. */
  async run(
    now = new Date(),
  ): Promise<{ plan: MplusSeasonTransitionPlan; purged: MplusPurgeOutcome[] }> {
    const plan = await this.plan(now);

    if (!plan.permitted) {
      this.logger.debug(`Mythic+ season purge not permitted: ${plan.reason}`);
      return { plan, purged: [] };
    }

    if (plan.blockedByArchive.length > 0) {
      this.logger.warn(
        `Holding back ${plan.blockedByArchive.length} Mythic+ season(s) the archive does not ` +
          `hold yet: ${plan.blockedByArchive.map((entry) => `${entry.season}/${entry.region}`).join(', ')}`,
      );
    }

    const purged: MplusPurgeOutcome[] = [];

    for (const candidate of plan.candidates) {
      purged.push(await this.purge(candidate, plan.current[candidate.region] ?? candidate.season));
    }

    return { plan, purged };
  }

  /**
   * Removes one season in one region from the live collections.
   *
   * No once-only guard of the kind the PvP purge keeps, on purpose: candidates
   * are derived from the rows stored, so a retired pair only comes back if rows
   * did — and then retiring it again is exactly right.
   *
   * Characters before runs, so the "every character is named by a run"
   * invariant (I18) holds at every intermediate moment rather than only at the
   * end: a crash between the two leaves runs with no characters, which reads
   * correctly (I15), never characters with no runs.
   */
  async purge(candidate: MplusPurgeCandidate, triggeredBy: string): Promise<MplusPurgeOutcome> {
    const { season, region } = candidate;
    const filter = { season, region };
    const removed: Record<string, number> = {};

    for (const name of [MPLUS_CHARACTERS_COLLECTION, MPLUS_RUNS_COLLECTION]) {
      removed[name] = this.dryRun
        ? await this.mongo.collection(name).countDocuments(filter)
        : (await this.mongo.collection(name).deleteMany(filter)).deletedCount;
    }

    this.logger.warn(
      `${this.dryRun ? '[dry run] Would retire' : 'Retired'} Mythic+ season ${season} ${region} ` +
        `(superseded by ${triggeredBy}): ${removed[MPLUS_RUNS_COLLECTION]} run(s), ` +
        `${removed[MPLUS_CHARACTERS_COLLECTION]} character(s)`,
    );

    await this.state.recordPurge({
      season,
      region,
      purgedAt: new Date(),
      removed,
      triggeredBy,
      dryRun: this.dryRun,
    });

    return { region, season, removed, dryRun: this.dryRun };
  }

  /** Season slugs with any live row in the region, runs and characters alike. */
  private async storedSeasons(region: RaiderIoRegion): Promise<string[]> {
    const [runs, characters] = await Promise.all([
      this.mongo.collection(MPLUS_RUNS_COLLECTION).distinct('season', { region }),
      this.mongo.collection(MPLUS_CHARACTERS_COLLECTION).distinct('season', { region }),
    ]);

    return [...new Set([...runs, ...characters])].filter(
      (season): season is string => typeof season === 'string',
    );
  }
}
