# Rankwarden

NestJS service that ingests World of Warcraft PvP leaderboards from the Blizzard
Game Data API and (as of the next iteration) persists them to MongoDB.

## Flow

1. **Boot** — env is validated with zod, MongoDB connects, indexes are ensured, and
   the Blizzard OAuth credentials are verified.
2. **Season resolution** — `GET /data/wow/pvp-season/index` per region; the active
   season id is cached in memory (`SeasonService`).
3. **Sweep** — for every `region × bracket` pair the leaderboard is fetched, validated
   with zod, and merged into the character documents. Brackets a character no longer
   ranks in are unset; characters left in no bracket at all are deleted.
4. **Repeat** — the sweep re-runs every `INGEST_INTERVAL_MS`. Overlapping sweeps are
   skipped rather than queued.
5. **Enrichment** — a separate background pass fills in race, class, spec and hero
   talent tree per character. Characters a sweep has just discovered are enriched
   immediately; everyone else is refreshed once their profile passes `PROFILE_TTL_MS`
   (1 day).

Regions: `us, eu, kr, tw`. Brackets: `2v2`, `3v3`, `rbg`, `shuffle-overall`, `blitz-overall`.

## Layout

```
src/
  main.ts                     bootstrap, log level, shutdown hooks
  app.module.ts               module composition
  config/                     zod env schema + global config module
  common/utils/               concurrency helper, token-bucket rate limiter
  common/events/              sweep-completed signal the enrichment pass listens to
  blizzard/
    blizzard.constants.ts     regions, brackets, host + namespace helpers
    auth/                     token provider seam + @denipetrov/blizz-auth adapter
    http/                     shared got instance (bearer auth, retries, namespace)
    schemas/                  zod schemas for season index + leaderboard payloads
    pvp.api.ts                typed PvP endpoints
  profile/                    background race/class/spec/hero-talent enrichment
  season/                     in-memory active season per region
  leaderboard/                sweep orchestration, mapper, character repository, scheduler
  database/                   MongoClient lifecycle
  health/                     GET /health — season snapshot + sweep state
scripts/db-check.mjs          standalone MongoDB connectivity + ingestion report
scripts/migrate-to-characters.mjs  folds legacy flat entries into the grouped shape
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

## Data model

One document per character per `season + region`, in the `characters` collection.
Every bracket they rank in is nested under `brackets`, so identity is stored once and
a character's full record is a single read.

```js
{
  seasonId: 42,
  region: 'eu',
  characterId: 225902312,
  characterName: 'Zëph',
  realmId: 1301,
  realmSlug: 'outland',
  faction: 'ALLIANCE',
  brackets: {
    '2v2':             { rank: 897,  rating: 1821, played: 51, won: 30, lost: 21, fetchedAt: … },
    '3v3':             { rank: 1282, rating: 1668, played: 47, won: 23, lost: 24, fetchedAt: … },
    'rbg':             { rank: 539,  rating: 384,  played: 2,  won: 2,  lost: 0,  fetchedAt: … },
    'shuffle-overall': { rank: 3774, rating: 1953, played: 99, won: 56, lost: 43, fetchedAt: … },
    'blitz-overall':   { rank: 695,  rating: 1969, played: 31, won: 14, lost: 17, fetchedAt: … },
  },
  updatedAt: …,

  // filled in by the enrichment pass, not the sweep
  profile: {
    race:           { id: 10, name: 'Blood Elf' },
    class:          { id: 2,  name: 'Paladin' },
    spec:           { id: 65, name: 'Holy' },
    heroTalentTree: { id: 49, name: 'Lightsmith' },   // null below hero-talent level
    level: 90, gender: 'FEMALE',
    guild: { id: 91360489, name: 'veow' },
    averageItemLevel: 278, equippedItemLevel: 278,
    lastLoginAt: …,
  },
  profileStatus: 'ok',        // 'missing' once Blizzard 404s the character
  profileFetchedAt: …,        // drives TTL selection; absent means never enriched
}
```

Indexes: a unique `seasonId + region + characterId` identity index, a
`characterName + realmSlug` lookup index, and one `brackets.<bracket>.rank` index per
bracket for ladder views.

Each bracket carries its own `fetchedAt` because brackets are swept independently — it
is what pruning compares against, and it tells you how stale any single ladder is.

### Migrating from the flat shape

Earlier builds wrote one document per `character × bracket` to `leaderboard_entries`.
`npm run db:migrate` folds those into `characters`; it is additive, re-runnable, and
never touches the source collection. Drop the old one once you have checked the result:

```bash
npm run db:shell   # then: db.leaderboard_entries.drop()
```

### Profile enrichment

Race, class and spec come from `/profile/wow/character/{realm}/{name}`; the hero talent
tree comes from that endpoint's `/specializations` sibling, whose top-level
`active_hero_talent_tree` matches the active loadout's selection. That is **two API
requests per character**, against a quota of 100/second and 36,000/hour — so enrichment
is its own budgeted pass rather than part of the sweep.

Selection is `profileFetchedAt` ascending, and the field is absent until a character is
first enriched, so never-seen characters always sort ahead of the daily refresh queue.
A finished sweep also fires a new-characters-only pass immediately, so ladder newcomers
do not wait out the interval.

At the defaults (500 characters per pass, every 5 minutes) that is 12,000 requests/hour
— a third of the quota, and roughly 72,000 characters a day against a ladder of ~35,000.
A 404 is recorded as `profileStatus: 'missing'` rather than retried, because renames and
transfers are routine.

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
