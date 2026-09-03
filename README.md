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
scripts/db-check.mjs          standalone MongoDB connectivity + ingestion report
docker-compose.yml            local mongo:8 + mongo-express
```

## Setup

```bash
npm install
cp .env.example .env   # fill in BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET
npm run db:up          # see "Local MongoDB" below
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

## Local MongoDB

Requires Docker Desktop (`docker compose` v2). If it is not installed yet, grab it from
https://www.docker.com/products/docker-desktop/ � it needs admin rights and a reboot,
and WSL2 must be enabled.

```bash
npm run db:up      # start mongo:8 + mongo-express, detached
npm run db:check   # verify connectivity and show what has been ingested
npm run start:dev  # first sweep runs at boot and writes to the database
```

| Service       | Address                     | Notes                                      |
| ------------- | --------------------------- | ------------------------------------------ |
| MongoDB       | `mongodb://localhost:27017` | database `rankwarden`, volume `mongo-data` |
| mongo-express | http://localhost:8081       | browse the ingested leaderboards           |

`docker-compose.yml` runs **without auth** so `MONGODB_URI` stays credential-free; it is
a development file only. Data lives in the named `mongo-data` volume and survives
`npm run db:down` � `npm run db:reset` is what discards it.

If port 27017 is already taken, remap it in `docker-compose.yml` (`'27018:27017'`) and
point `MONGODB_URI` at the new port.

## Debugging (VS Code)

`.vscode/launch.json` ships seven configurations; pick one from the Run and Debug panel.

| Configuration                | Use it for                                                                |
| ---------------------------- | ------------------------------------------------------------------------- |
| Debug app                    | Build, then break anywhere in a normal startup + first sweep              |
| Debug app (watch)            | `nest start --debug --watch`; reattaches after every save                 |
| Debug app (no startup sweep) | Boot with `INGEST_RUN_ON_STARTUP=false` to step a sweep on your own terms |
| Debug current test file      | Runs Vitest on the open file with `--no-file-parallelism`                 |
| Debug all tests              | The whole suite, single process                                           |
| Debug db:check               | Steps through the MongoDB report script                                   |
| Attach to running app        | Attaches to port 9229 of an already-running `npm run start:debug`         |

Breakpoints are set in `src/` and resolve through the sourcemaps `tsc` writes into `dist/`,
so `outFiles` points at `dist/**/*.js`. The launch configs read `.env` via `envFile`.

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
