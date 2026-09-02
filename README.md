# Rankwarden

NestJS service that ingests World of Warcraft PvP leaderboards from the Blizzard
Game Data API and (as of the next iteration) persists them to MongoDB.

## Flow

1. **Boot** — env is validated with zod, MongoDB connects, indexes are ensured, and
   the Blizzard OAuth credentials are verified.
2. **Season resolution** — `GET /data/wow/pvp-season/index` per region; the active
   season id is cached in memory (`SeasonService`).
3. **Sweep** — for every `region × bracket` pair the leaderboard is fetched, validated
   with zod, flattened, and upserted. Entries that fell off the ladder since the
   previous sweep are pruned.
4. **Repeat** — the sweep re-runs every `INGEST_INTERVAL_MS`. Overlapping sweeps are
   skipped rather than queued.

Regions: `us, eu, kr, tw`. Brackets: `2v2`, `3v3`, `rbg`, `shuffle-overall`, `blitz-overall`.

## Layout

```
src/
  main.ts                     bootstrap, log level, shutdown hooks
  app.module.ts               module composition
  config/                     zod env schema + global config module
  common/utils/               concurrency helper (bounded parallel sweeps)
  blizzard/
    blizzard.constants.ts     regions, brackets, host + namespace helpers
    auth/                     token provider seam + @denipetrov/blizz-auth adapter
    http/                     shared got instance (bearer auth, retries, namespace)
    schemas/                  zod schemas for season index + leaderboard payloads
    pvp.api.ts                typed PvP endpoints
  season/                     in-memory active season per region
  leaderboard/                sweep orchestration, mapper, Mongo repository, scheduler
  database/                   MongoClient lifecycle
  health/                     GET /health — season snapshot + sweep state
```

## Setup

```bash
npm install
cp .env.example .env   # fill in BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET
npm run start:dev
```

> The `@denipetrov` scope resolves to GitHub Packages via `.npmrc`, which needs a
> token with `read:packages`:
>
> ```bash
> npm config set //npm.pkg.github.com/:_authToken=$(gh auth token)
> ```
>
> `.npmrc` deliberately holds only the registry line, never the token.

`BLIZZARD_REGION` is the OAuth host region used to mint the token (`us|eu|kr|tw|cn`);
`BLIZZARD_REGIONS` is the separate list of ladders to ingest.

## Scripts

| Script                                                 | Purpose                                 |
| ------------------------------------------------------ | --------------------------------------- |
| `npm run start:dev`                                    | Watch mode                              |
| `npm run build` / `npm run start:prod`                 | Compile to `dist/`, run compiled output |
| `npm test` / `npm run test:watch` / `npm run test:cov` | Vitest                                  |
| `npm run typecheck`                                    | `tsc --noEmit`                          |
| `npm run lint` / `npm run format`                      | ESLint / Prettier                       |

## Notes

- The project is **ESM** (`"type": "module"`, `module: nodenext`), which `got` v16
  requires. Relative imports therefore carry the `.js` extension.
- Vitest runs sources through SWC so `emitDecoratorMetadata` works and Nest DI can be
  exercised in unit tests (see `src/season/season.service.spec.ts`).
- `@denipetrov/blizz-auth` caches tokens per `region + clientId` and refreshes 60s
  before expiry, so `BlizzardTokenService` deliberately holds no cache of its own.
- MongoDB is written through the official `mongodb` driver, no ODM.
