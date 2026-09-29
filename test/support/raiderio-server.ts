import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MAX_RUNS_PAGE } from '../../src/raiderio/raiderio.constants.js';
import { MplusWorld } from './mplus-world.js';

export interface RaiderIoServerHit {
  /** Path under the API root, `mythic-plus/runs`. */
  path: string;
  query: URLSearchParams;
  at: number;
}

/**
 * Answers one request in place of the world, or returns false to let the world
 * answer it. `hit` is the request's own record, already counted.
 */
export type RaiderIoServerHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  hit: RaiderIoServerHit,
) => boolean | void;

const API_ROOT = '/api/v1/';

/**
 * A real Raider.io listener over an `MplusWorld`, for the tests that need the
 * real `RaiderIoHttpService` rather than `FakeRaiderIo`.
 *
 * `FakeRaiderIo` replaces the client at the seam, which is right for almost
 * everything and means everything the client itself promises — retries,
 * `Retry-After`, the access key added last, the token bucket, the empty-body
 * check — has never run in a test. This serves the same payloads over HTTP, so
 * the client can be pointed at it through `RAIDERIO_API_BASE_URL`.
 *
 * `handler` takes over any request it wants, which is how a status sequence, a
 * slow answer or an empty body is staged.
 */
export class RaiderIoServer {
  readonly hits: RaiderIoServerHit[] = [];
  handler?: RaiderIoServerHandler;
  private server?: Server;

  constructor(readonly world: MplusWorld = new MplusWorld()) {}

  /** Starts listening on an ephemeral port; resolves to the base url to configure. */
  async start(): Promise<string> {
    this.server = createServer((request, response) => this.serve(request, response));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;

    return `http://127.0.0.1:${port}${API_ROOT.replace(/\/$/, '')}`;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    // A request parked by a handler that never answers would hold `close` open.
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  /** Hits on one path, for attempt counting. */
  hitsFor(path: string): RaiderIoServerHit[] {
    return this.hits.filter((hit) => hit.path === path);
  }

  reset(): void {
    this.hits.length = 0;
    this.handler = undefined;
  }

  private serve(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const hit: RaiderIoServerHit = {
      path: url.pathname.startsWith(API_ROOT) ? url.pathname.slice(API_ROOT.length) : url.pathname,
      query: url.searchParams,
      at: Date.now(),
    };
    this.hits.push(hit);

    if (this.handler?.(request, response, hit)) return;

    const { status, body } = this.route(hit);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  private route(hit: RaiderIoServerHit): { status: number; body: unknown } {
    const season = hit.query.get('season') ?? 'season-mn-2';
    const region = hit.query.get('region') ?? 'us';

    if (hit.path === 'mythic-plus/static-data') {
      return { status: 200, body: this.world.staticData(Number(hit.query.get('expansion_id'))) };
    }

    if (hit.path === 'mythic-plus/season-cutoffs') {
      if (this.world.seasonsWithoutCutoffs.has(season)) {
        return { status: 404, body: { statusCode: 404, message: 'Could not find cutoffs' } };
      }

      return { status: 200, body: this.world.cutoffs(season, region) };
    }

    if (hit.path === 'mythic-plus/runs') {
      const page = Number(hit.query.get('page') ?? 0);

      if (page > MAX_RUNS_PAGE) {
        return {
          status: 400,
          body: { statusCode: 400, message: '"page" must be less than or equal to 1000' },
        };
      }

      return { status: 200, body: this.world.runsPage(season, region, page) };
    }

    return { status: 404, body: { statusCode: 404, message: `unrouted path ${hit.path}` } };
  }
}
