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
  at: number;
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
  /** Paths set to fail, and how. Keyed by a fragment of the path. */
  readonly failures = new Map<string, { status?: number; empty?: boolean; times?: number }>();
  peakInFlight = 0;
  private inFlight = 0;

  constructor(private readonly world: MplusWorld) {}

  reset(): void {
    this.requests.length = 0;
    this.failures.clear();
    this.peakInFlight = 0;
  }

  /** Requests issued for one path fragment, for quota and pagination assertions. */
  countMatching(fragment: string): number {
    return this.requests.filter((request) => request.path.includes(fragment)).length;
  }

  /** Makes the next `times` matching requests fail with a status, or an empty body. */
  failWith(fragment: string, options: { status?: number; empty?: boolean; times?: number }): void {
    this.failures.set(fragment, options);
  }

  async get(path: string, options: RaiderIoGetOptions = {}): Promise<unknown> {
    const params = options.searchParams ?? {};
    const region = String(params.region ?? options.region ?? 'global');
    const season = params.season === undefined ? null : String(params.season);
    const page = params.page === undefined ? null : Number(params.page);

    this.requests.push({ path, region, season, page, at: Date.now() });

    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    // Charged to the run in progress, as the real client's beforeRequest hook
    // does. The fake never retries, so one call is one charge.
    this.budget?.record(raiderIoConsumerFor(currentRunKind()));

    const startedAt = Date.now();
    const url = `https://raider.io/api/v1/${path}`;

    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));

      const failure = this.nextFailure(path, page);

      if (failure?.empty) throw new RaiderIoEmptyResponseError(url);
      if (failure?.status) {
        throw new RaiderIoApiError(
          failure.status,
          url,
          `Raider.io API ${failure.status} for ${url}`,
        );
      }

      const payload = this.route(path, region, season, page, url);

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

  private nextFailure(
    path: string,
    page: number | null,
  ): { status?: number; empty?: boolean } | null {
    for (const [fragment, options] of this.failures) {
      const matches = path.includes(fragment) || (page !== null && fragment === `page:${page}`);
      if (!matches) continue;

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
  ): unknown {
    if (path === 'mythic-plus/static-data') return this.world.staticData();

    if (path === 'mythic-plus/runs') {
      // The endpoint's real behaviour past its cap: a 400 naming the parameter,
      // not an empty page. The pass treats it as the end of the data, so a fake
      // that answered 200 would leave that branch untested.
      if (page !== null && page > MAX_RUNS_PAGE) {
        throw new RaiderIoApiError(400, url, '"page" must be less than or equal to 1000');
      }

      if (!this.world.regions.includes(region)) {
        throw new RaiderIoApiError(404, url, `region ${region} is not in this world`);
      }

      return this.world.runsPage(season ?? 'season-mn-2', region, page ?? 0);
    }

    throw new RaiderIoApiError(404, url, `unrouted path ${path}`);
  }
}
