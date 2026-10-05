import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { RunLogger } from '../common/logging/run-context.js';
import { describeError } from '../common/utils/errors.js';
import type { Env } from '../config/env.schema.js';
import { RaiderIoApiError } from '../raiderio/http/raiderio-api.error.js';
import { RaidingApi } from '../raiderio/raiding.api.js';
import { toRaidDocument } from './raid-catalogue.mapper.js';
import { RaidCatalogueRepository } from './raid-catalogue.repository.js';

/**
 * A hard stop for the expansion walk, far above any real expansion id. The walk
 * ends at the first expansion Raider.io does not list; this only matters if it
 * ever answered every id.
 */
const MAX_EXPANSIONS_WALKED = 30;

export interface RaidCatalogueRefresh {
  refreshed: boolean;
  /** Why nothing was fetched, when nothing was. */
  reason: string | null;
  expansions: number[];
  raids: number;
  /** Raids a complete walk no longer listed. */
  unlisted: number;
}

/** What the health endpoint reports of the job, from memory. */
export interface RaidCatalogueStatus {
  running: boolean;
  lastWalk: {
    finishedAt: string;
    expansions: number[];
    raids: number;
    unlisted: number;
    /** Whether the walk reached the end of the list. */
    complete: boolean;
  } | null;
}

/**
 * Keeps the raid catalogue in step with Raider.io: one document per raid, with
 * its encounters and its per-region dates. The raiding counterpart of
 * `MplusCatalogueService`, and walked the same way — one request per
 * expansion, six today.
 *
 * It is small and cheap but not static: a new raid is listed before it opens,
 * and a running raid carries a placeholder end (`2030-01-01`) that Raider.io
 * replaces with the real date once the tier is over. So it is re-read on a TTL
 * rather than once.
 */
@Injectable()
export class RaidCatalogueService {
  private readonly logger = new RunLogger(RaidCatalogueService.name);
  private readonly firstExpansion: number;
  private readonly ttlMs: number;
  private inFlight: Promise<RaidCatalogueRefresh> | null = null;
  private last: RaidCatalogueStatus['lastWalk'] = null;

  constructor(
    config: ConfigService<Env, true>,
    private readonly api: RaidingApi,
    private readonly repository: RaidCatalogueRepository,
  ) {
    this.firstExpansion = config.get('RAID_CATALOGUE_FIRST_EXPANSION', { infer: true });
    this.ttlMs = config.get('RAID_CATALOGUE_TTL_MS', { infer: true });
  }

  /** Whether a walk is going and how the last one ended, for the health endpoint. */
  get lastStatus(): RaidCatalogueStatus {
    return { running: this.inFlight !== null, lastWalk: this.last };
  }

  /** Refreshes the catalogue when it is empty or older than its TTL. */
  async refreshIfDue(now = new Date()): Promise<RaidCatalogueRefresh> {
    const updatedAt = await this.repository.catalogueUpdatedAt();

    if (updatedAt && now.getTime() - updatedAt.getTime() < this.ttlMs) {
      return {
        refreshed: false,
        reason: `raid catalogue is fresh (read ${updatedAt.toISOString()})`,
        expansions: [],
        raids: 0,
        unlisted: 0,
      };
    }

    return this.refresh(now);
  }

  /**
   * Walks expansions upward from the first, stopping at the first Raider.io
   * does not list. One walk is shared between callers that ask at once.
   *
   * **The end of the list is a 400**, not an empty answer: an expansion with no
   * raids is "Requested unsupported expansion_id". That is the only failure
   * read as the end. Any other — a 5xx, a timeout, a payload that does not
   * parse — stops the walk without reaching the end, so the later expansions
   * are left as they were rather than taken for gone; what was written stays,
   * and the next refresh starts from the beginning.
   */
  refresh(now = new Date()): Promise<RaidCatalogueRefresh> {
    if (!this.inFlight) {
      this.inFlight = this.walk(now).finally(() => {
        this.inFlight = null;
      });
    }

    return this.inFlight;
  }

  private async walk(now: Date): Promise<RaidCatalogueRefresh> {
    const expansions: number[] = [];
    let raids = 0;
    // Whether the walk reached the end of the list, rather than stopping on a
    // failure or the hard stop: only then is "no longer listed" known.
    let complete = false;
    // A 400 ends the list — unless raids of a later expansion are stored, when
    // it is a hole in the middle: one bad answer for expansion 10 must not
    // have every raid of 10 and 11 taken for gone.
    const newestKnown = await this.repository.highestListedExpansion();
    let holes = 0;

    for (let offset = 0; offset < MAX_EXPANSIONS_WALKED; offset += 1) {
      const expansionId = this.firstExpansion + offset;
      let data;

      try {
        data = await this.api.getStaticData(expansionId);
      } catch (error) {
        if (error instanceof RaiderIoApiError && error.isBadRequest) {
          if (newestKnown !== null && expansionId <= newestKnown) {
            holes += 1;
            this.logger.warn(
              `Raider.io lists no raids for expansion ${expansionId}, though raids of ` +
                `expansion ${newestKnown} are stored; not taking it for the end of the list`,
            );
            continue;
          }

          complete = holes === 0;
          break;
        }

        this.logger.warn(
          `Could not read the raid catalogue for expansion ${expansionId}: ` +
            `${describeError(error)}; stopping the walk here`,
        );
        break;
      }

      // Not how the endpoint ends its list today, but the same thing said the
      // way the Mythic+ static data says it.
      if (data.raids.length === 0) {
        complete = true;
        break;
      }

      expansions.push(expansionId);
      raids += await this.repository.upsertRaids(
        data.raids.map((raid) => toRaidDocument(raid, expansionId, now)),
      );
    }

    if (complete && expansions.length === 0) {
      // The first expansion asked for is itself unsupported: a configuration
      // mistake, not an empty game. Nothing is marked unlisted on that basis.
      this.logger.warn(
        `Raider.io lists no raids for expansion ${this.firstExpansion}; ` +
          'check RAID_CATALOGUE_FIRST_EXPANSION',
      );
    }

    const unlisted =
      complete && expansions.length > 0 ? await this.repository.markUnlisted(now) : 0;

    this.logger.log(
      `Raid catalogue refreshed across expansion(s) ${expansions.join(', ') || 'none'}: ` +
        `${raids} raid write(s)` +
        (unlisted > 0 ? `; ${unlisted} raid(s) no longer listed` : ''),
    );

    this.last = { finishedAt: new Date().toISOString(), expansions, raids, unlisted, complete };

    return { refreshed: expansions.length > 0, reason: null, expansions, raids, unlisted };
  }
}
