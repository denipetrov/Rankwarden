import type { DependencyHealth } from '../../src/common/health/dependency-health.service.js';
import { currentRunKind } from '../../src/common/logging/run-context.js';
import {
  raiderIoConsumerFor,
  type RaiderIoBudget,
} from '../../src/common/quota/raiderio-budget.service.js';
import {
  RaiderIoApiError,
  RaiderIoEmptyResponseError,
} from '../../src/raiderio/http/raiderio-api.error.js';
import type { RaiderIoGetOptions } from '../../src/raiderio/http/raiderio-http.service.js';
import { MAX_RUNS_PAGE } from '../../src/raiderio/raiderio.constants.js';
import type { MplusWorld } from './mplus-world.js';

export interface RecordedRaiderIoRequest {
  path: string;
  region: string;
  season: string | null;
  page: number | null;
  /** The `expansion_id` a static-data request named, else null. */
  expansionId: number | null;
  /** Every query parameter the request carried, for asserting what was asked. */
  params: Record<string, string | number>;
  at: number;
}

/**
 * Which requests a failure or a corruption applies to.
 *
 * One condition, or several joined with `&`, all of which must hold:
 *
 * - a fragment of the path, `mythic-plus/runs`;
 * - `page:<n>`, `region:<r>`, `season:<slug>`, `expansion:<id>`.
 *
 * The keyed forms exist because a path alone cannot tell requests apart: every
 * static-data call has the same path, so "expansion 11 fails" has no other way
 * to be said, and a region-specific outage would otherwise have to be staged by
 * giving the region no board.
 */
export type RequestMatcher = string;

function matches(matcher: RequestMatcher, request: RecordedRaiderIoRequest): boolean {
  return matcher.split('&').every((condition) => {
    const [key, value] = condition.split(':');

    if (value === undefined) return request.path.includes(condition);

    switch (key) {
      case 'page':
        return request.page === Number(value);
      case 'region':
        return request.region === value;
      case 'season':
        return request.season === value;
      case 'expansion':
        return request.expansionId === Number(value);
      default:
        return request.path.includes(condition);
    }
  });
}

/**
 * Stands in for `RaiderIoHttpService`, serving raw JSON out of an `MplusWorld`.
 *
 * The same seam as `FakeBlizzard` and for the same reason: replacing
 * `MythicPlusApi` instead would take every zod schema out of the test, and the
 * schemas are where the payload traps live — an anonymised realm with no
 * `wowRealmId`, a null `loadout`, a page past the end answering 400 rather than
 * an empty list. Here the real schemas parse the fake payloads.
 */
export class FakeRaiderIo {
  readonly requests: RecordedRaiderIoRequest[] = [];
  /** Artificial latency, for asserting pacing and concurrency. */
  delayMs = 0;
  /**
   * Where observed Raider.io health is recorded. Without this wiring readiness
   * would report `unknown` for Raider.io in every integration test and the
   * degraded path would be unreachable. Set by `bootTestApp`.
   */
  health?: DependencyHealth;
  /**
   * The Raider.io budget, charged once per request exactly as the real client's
   * `beforeRequest` hook charges it. Without it every test would run against a
   * budget that never fills and the throttling path could not be reached. Set
   * by `bootTestApp`.
   */
  budget?: RaiderIoBudget;
  /** Requests set to fail, and how. Keyed by a `RequestMatcher`. */
  readonly failures = new Map<
    RequestMatcher,
    { status?: number; empty?: boolean; times?: number }
  >();
  /** Requests answered with an arbitrary body instead of the world's. */
  readonly corruptions = new Map<RequestMatcher, { payload: unknown; times?: number }>();
  /**
   * Called as each request is served, before its payload is built. Lets a test
   * change the world mid-job — start a higher-priority job partway through a
   * season, say — at a point the job cannot see coming.
   */
  beforeServe?: (request: RecordedRaiderIoRequest) => void;
  peakInFlight = 0;
  private inFlight = 0;

  constructor(private readonly world: MplusWorld) {}

  reset(): void {
    this.beforeServe = undefined;
    this.requests.length = 0;
    this.failures.clear();
    this.corruptions.clear();
    this.delayMs = 0;
    this.peakInFlight = 0;
  }

  /** Requests issued for one path fragment, for quota and pagination assertions. */
  countMatching(fragment: string): number {
    return this.requests.filter((request) => request.path.includes(fragment)).length;
  }

  /** Makes the next `times` matching requests fail with a status, or an empty body. */
  failWith(
    matcher: RequestMatcher,
    options: { status?: number; empty?: boolean; times?: number },
  ): void {
    this.failures.set(matcher, options);
  }

  /**
   * Answers the next `times` matching requests with `payload` instead of the
   * world's. A 200 carrying the wrong shape, which is schema drift: the one
   * failure a status cannot express, and the one the zod boundary exists for.
   */
  corrupt(matcher: RequestMatcher, payload: unknown, times?: number): void {
    this.corruptions.set(matcher, { payload, times });
  }

  async get(path: string, options: RaiderIoGetOptions = {}): Promise<unknown> {
    const params = options.searchParams ?? {};
    const region = String(params.region ?? options.region ?? 'global');
    const season = params.season === undefined ? null : String(params.season);
    const page = params.page === undefined ? null : Number(params.page);
    const expansionId = params.expansion_id === undefined ? undefined : Number(params.expansion_id);

    const request: RecordedRaiderIoRequest = {
      path,
      region,
      season,
      page,
      expansionId: expansionId ?? null,
      params: { ...params },
      at: Date.now(),
    };
    this.requests.push(request);

    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    // Charged to the run in progress, as the real client's beforeRequest hook
    // does. The fake never retries, so one call is one charge.
    this.budget?.record(raiderIoConsumerFor(currentRunKind()));

    const startedAt = Date.now();
    const url = `https://raider.io/api/v1/${path}`;

    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));

      this.beforeServe?.(request);

      const failure = this.next(this.failures, request);

      if (failure?.empty) throw new RaiderIoEmptyResponseError(url);
      if (failure?.status) {
        throw new RaiderIoApiError(
          failure.status,
          url,
          `Raider.io API ${failure.status} for ${url}`,
        );
      }

      const corruption = this.next(this.corruptions, request);
      const payload = corruption
        ? corruption.payload
        : this.route(path, region, season, page, url, expansionId);

      // Mirrors the real client, which rejects an empty body as a transport
      // failure rather than letting `''` reach the zod boundary and be misread
      // as payload drift.
      if (payload === '' || payload === null || payload === undefined) {
        throw new RaiderIoEmptyResponseError(url);
      }

      this.health?.recordSuccess('raiderio', options.region ?? 'global', Date.now() - startedAt);

      return payload;
    } catch (error) {
      const status = error instanceof RaiderIoApiError ? error.statusCode : null;
      const reason = error instanceof Error ? error.message : String(error);
      this.health?.recordFailure('raiderio', options.region ?? 'global', reason, status);

      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  /** The first entry matching the request with uses left, spending one of them. */
  private next<T extends { times?: number }>(
    entries: Map<RequestMatcher, T>,
    request: RecordedRaiderIoRequest,
  ): T | null {
    for (const [matcher, options] of entries) {
      if (!matches(matcher, request)) continue;

      if (options.times !== undefined) {
        if (options.times <= 0) continue;
        options.times -= 1;
      }

      return options;
    }

    return null;
  }

  private route(
    path: string,
    region: string,
    season: string | null,
    page: number | null,
    url: string,
    expansionId?: number,
  ): unknown {
    if (path === 'mythic-plus/static-data') return this.world.staticData(expansionId);

    if (path === 'mythic-plus/season-cutoffs') {
      // No cutoffs for the season: a 404 naming it, as upstream answers for
      // everything before `season-sl-3`.
      if (season !== null && this.world.seasonsWithoutCutoffs.has(season)) {
        throw new RaiderIoApiError(404, url, `Could not find cutoffs for season ${season}`);
      }

      return this.world.cutoffs(season ?? 'season-mn-2', region);
    }

    if (path === 'mythic-plus/runs') {
      // The endpoint's real behaviour past its cap: a 400 naming the parameter,
      // not an empty page. The pass treats it as the end of the data, so a fake
      // that answered 200 would leave that branch untested.
      if (page !== null && page > MAX_RUNS_PAGE) {
        throw new RaiderIoApiError(400, url, '"page" must be less than or equal to 1000');
      }

      // `world` included: nothing reads the aggregate board any more, so a
      // request for it is a regression and fails like any unknown region.
      if (!this.world.regions.includes(region)) {
        throw new RaiderIoApiError(404, url, `region ${region} is not in this world`);
      }

      if (season !== null && this.world.unservedSeasons.has(season)) {
        throw new RaiderIoApiError(404, url, `season ${season} is not served`);
      }

      return this.world.runsPage(season ?? 'season-mn-2', region, page ?? 0);
    }

    throw new RaiderIoApiError(404, url, `unrouted path ${path}`);
  }
}
