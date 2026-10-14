import type { ConfigService } from '@nestjs/config';

import type { Env } from '../../config/env.schema.js';

/**
 * The upstreams Rankwarden reports health for, as keys into the shared
 * `DependencyHealth` from `@denipetrov/spirit-link/health`. All are soft
 * dependencies; only Mongo is hard.
 *
 * `raiderioRankings` is Raider.io's raid-ranking endpoint, observed apart from
 * the rest of Raider.io: it is slow enough to time out by itself and nothing
 * live depends on it, so it is reported and never judged.
 */
export const UpstreamProvider = {
  Blizzard: 'blizzard',
  RaiderIo: 'raiderio',
  RaiderIoRankings: 'raiderioRankings',
} as const;
export type UpstreamProvider = (typeof UpstreamProvider)[keyof typeof UpstreamProvider];

/**
 * What `DependencyHealth` must never repeat in a reported error.
 *
 * The Raider.io key travels as a query parameter, so it turns up inside any url
 * an error message quotes. The client keeps it out of the urls it reports, and
 * this catches whatever quotes one it did not build.
 */
export function healthSecrets(config: ConfigService<Env, true>): string[] {
  return [
    config.get('BLIZZARD_CLIENT_SECRET', { infer: true }),
    config.get('BLIZZARD_CLIENT_ID', { infer: true }),
    config.get('RAIDER_IO_API_KEY', { infer: true }),
  ];
}
