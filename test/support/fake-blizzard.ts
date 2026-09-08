import { BlizzardApiError } from '../../src/blizzard/http/blizzard-api.error.js';
import type { BlizzardGetOptions } from '../../src/blizzard/http/blizzard-http.service.js';
import type { Region } from '../../src/blizzard/blizzard.constants.js';
import type { DependencyHealth } from '../../src/common/health/dependency-health.service.js';
import type { World, WorldPlayer, WorldRegion } from './world.js';

export interface RecordedRequest {
  region: string;
  path: string;
  namespace: string;
  at: number;
}

/**
 * Stands in for `BlizzardHttpService`, serving raw JSON out of the World.
 *
 * This is the right seam. Overriding `PvpApi` or `ProfileApi` instead would
 * take every zod schema out of the test, and the schemas are exactly where the
 * payload traps live — an aggregate bracket with no third segment,
 * `season_name` arriving as null, `leaderboards[].id` present only on the first
 * entry. Here the real schemas parse the fake payloads.
 */
export class FakeBlizzard {
  readonly requests: RecordedRequest[] = [];
  /** Artificial latency, for asserting concurrency and rate limits. */
  delayMs = 0;
  /**
   * Where observed Blizzard health is recorded.
   *
   * The real `BlizzardHttpService` is what feeds `DependencyHealth`, and this
   * fake replaces it — so without this wiring the readiness endpoint would
   * report `unknown` for Blizzard in every integration test, and the whole
   * degraded path would be untestable. Set by `bootTestApp`.
   */
  health?: DependencyHealth;
  peakInFlight = 0;
  private inFlight = 0;

  constructor(private readonly world: World) {}

  /** Requests issued for one path fragment, for quota assertions. */
  countMatching(fragment: string): number {
    return this.requests.filter((request) => request.path.includes(fragment)).length;
  }

  reset(): void {
    this.requests.length = 0;
    this.peakInFlight = 0;
  }

  async get(region: Region, path: string, options: BlizzardGetOptions = {}): Promise<unknown> {
    this.requests.push({
      region,
      path,
      namespace: `${options.namespace ?? 'dynamic'}-${region}`,
      at: Date.now(),
    });

    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);

    const startedAt = Date.now();

    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));

      const payload = this.route(region as WorldRegion, path);
      this.health?.recordBlizzardSuccess(region, Date.now() - startedAt);

      return payload;
    } catch (error) {
      const status = error instanceof BlizzardApiError ? error.statusCode : null;
      const reason = error instanceof Error ? error.message : String(error);
      this.health?.recordBlizzardFailure(region, reason, status);

      throw error;
    } finally {
      this.inFlight -= 1;
    }
  }

  private route(region: WorldRegion, path: string): unknown {
    if (!this.world.regions.includes(region)) {
      throw this.error(404, path, `region ${region} is not in this world`);
    }

    if (/^data\/wow\/pvp-season\/index$/.test(path)) {
      return this.serve(region, 'index', path, () => this.world.seasonIndex(region));
    }

    const season = /^data\/wow\/pvp-season\/(\d+)$/.exec(path);
    if (season) {
      return this.serve(region, 'season', path, () => {
        const payload = this.world.seasonPayload(region, Number(season[1]));
        if (!payload) throw this.error(404, path, `no season ${season[1]}`);

        return payload;
      });
    }

    const bracketIndex = /^data\/wow\/pvp-season\/(\d+)\/pvp-leaderboard\/index$/.exec(path);
    if (bracketIndex) {
      return this.serve(region, 'brackets', path, () => {
        if (!this.knowsSeason(region, Number(bracketIndex[1]))) {
          throw this.error(404, path, `no season ${bracketIndex[1]}`);
        }

        return {
          // Blizzard sends `id` on the first entry only, which is why the
          // schema has it optional. Reproduced, so a regression is caught here.
          leaderboards: this.world.brackets(region).map((bracket, index) => ({
            name: bracket,
            ...(index === 0 ? { id: 1 } : {}),
          })),
        };
      });
    }

    const ladder = /^data\/wow\/pvp-season\/(\d+)\/pvp-leaderboard\/(.+)$/.exec(path);
    if (ladder) {
      const seasonId = Number(ladder[1]);
      const bracket = decodeURIComponent(ladder[2]);

      return this.serve(region, bracket, path, () => {
        if (!this.world.brackets(region).includes(bracket)) {
          throw this.error(404, path, `bracket ${bracket} is not published`);
        }
        if (!this.knowsSeason(region, seasonId)) {
          throw this.error(404, path, `no season ${seasonId}`);
        }

        return this.world.ladder(region, seasonId, bracket);
      });
    }

    const specs = /^profile\/wow\/character\/([^/]+)\/([^/]+)\/specializations$/.exec(path);
    if (specs) {
      return this.serve(region, `character:${specs[1]}/${specs[2]}`, path, () =>
        this.world.specsPayload(this.characterAt(region, specs[1], specs[2], path)),
      );
    }

    const profile = /^profile\/wow\/character\/([^/]+)\/([^/]+)$/.exec(path);
    if (profile) {
      return this.serve(region, `character:${profile[1]}/${profile[2]}`, path, () =>
        this.world.profilePayload(this.characterAt(region, profile[1], profile[2], path)),
      );
    }

    throw this.error(404, path, `no route for ${path}`);
  }

  /**
   * Applies injected faults, then builds the payload.
   *
   * A corruption short-circuits the build and is returned as-is, so the caller
   * parses a structurally wrong payload with the real schema — which is the
   * behaviour under test, not an error the fake should raise itself.
   */
  private serve(region: WorldRegion, key: string, path: string, build: () => unknown): unknown {
    const status = this.world.failureFor(region, key);
    if (status !== undefined) throw this.error(status, path, `injected ${status}`);

    const corruption = this.world.corruptionFor(region, key);
    if (corruption !== undefined) return corruption;

    return build();
  }

  private characterAt(
    region: WorldRegion,
    realmSlug: string,
    encodedName: string,
    path: string,
  ): WorldPlayer {
    const player = this.world.findPlayer(region, realmSlug, decodeURIComponent(encodedName));

    // A renamed, transferred or deleted character 404s here while its ladder
    // entries stay put. Routine, not a failure.
    if (!player || player.deleted) throw this.error(404, path, 'character not found');

    return player;
  }

  private knowsSeason(region: WorldRegion, seasonId: number): boolean {
    return this.world.seasonPayload(region, seasonId) !== null;
  }

  /**
   * Mirrors the message `BlizzardHttpService` builds, attempt count included.
   *
   * Anything asserting on error text — and the sweep's own failure lines carry
   * it straight through — is meaningless if the fake's wording drifts from the
   * real one.
   */
  private error(status: number, path: string, message: string, attempts = 1): BlizzardApiError {
    return new BlizzardApiError(
      status,
      path,
      `Blizzard API ${status} for ${path} after ${attempts} ` +
        `${attempts === 1 ? 'attempt' : 'attempts'}: ${message}`,
      { attempts },
    );
  }
}
