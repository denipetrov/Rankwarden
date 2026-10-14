# Rankwarden

Rankwarden collects World of Warcraft rankings and keeps them in MongoDB for other
applications to read. It pulls the rated PvP ladders and character profiles from Blizzard,
and Mythic+ runs and raid progression from Raider.io, on a schedule, and stores them in
shapes that let a website show any leaderboard with a single indexed query.

It is a background service. It has no user-facing API: a separate backend reads the
database directly, and can push corrections back through two sync endpoints.

## What it collects

| Area           | From      | What is stored                                                                                         | How often             |
| -------------- | --------- | ------------------------------------------------------------------------------------------------------ | --------------------- |
| PvP ladders    | Blizzard  | Every rated ladder (2v2, 3v3, rated battlegrounds, Solo Shuffle and Blitz per spec) in us, eu, kr, tw | Every hour            |
| PvP characters | Blizzard  | Race, class, spec, hero talents and talent builds, guild, title, item level                            | Specs daily, rest weekly |
| Spec popularity | computed | Which specs and hero talents are played above 1500, 1800, 2100, 2300 and 2700 rating                 | Once a day            |
| PvP history    | Blizzard  | Final standings of every finished season (from season 27), and the rating each title required        | Once per season       |
| Mythic+        | Raider.io | The top ~20,000 runs per region (us, eu, kr, tw, cn), the characters in them, dungeons, affixes        | Every 6 hours         |
| Mythic+ extras | Raider.io | Season catalogue, title cutoffs (Keystone Master and up, top 0.1% and 1%), spec usage per dungeon      | With each pass        |
| Mythic+ history | Raider.io | The top 2,000 runs per region of every finished season since Legion                                  | Once per season       |
| Raids          | Raider.io | Every raid since Legion with its bosses, and the top 100 guilds per raid, region and difficulty        | Hourly while open     |

When a new season starts, the previous one is removed from the live collections, region by
region, but only after it has been archived. During the gap between two seasons the
finished season stays visible.

## How it works

Each kind of data has its own job, running on its own timer. The jobs share two limited
resources: Blizzard allows 36,000 requests an hour and Raider.io 1,000 a minute. So the
service:

- **Runs the jobs in a fixed order of importance**: the hourly PvP ladders first, then
  character profiles, then Mythic+, then the archives, and raid rankings last. A
  lower-priority job waits while a higher one runs, and long jobs pause and resume.
- **Keeps a budget for each upstream** and charges every request to the job that made it,
  retries included, so no job can starve another of quota.
- **Remembers where it was.** Progress markers mean an interrupted archive resumes where it
  stopped, and season state survives a restart.
- **Runs as a single instance.** The schedule and the budgets live in the process, so a
  second copy would do everything twice. The deployment enforces one replica.

On a typical hour: the PvP sweep reads 332 ladders in about 35 seconds, profile updates
use up to 12,000 requests, and the archives use what is left.

## Getting started

You need:

- **Node.js 22 or later** (production uses 24)
- **Docker Desktop**, for the local MongoDB
- **A GitHub token with `read:packages`**, for the two private packages
  `@denipetrov/blizz-auth` and `@denipetrov/spirit-link`
- **Blizzard API credentials**, from https://develop.battle.net/access/clients
- **A Raider.io API key**, from https://raider.io/settings/apps — only if you turn on the
  Mythic+ or raid jobs

```bash
# once: let npm read the private packages (the token stays in your user config)
npm config set //npm.pkg.github.com/:_authToken=$(gh auth token)

npm install
cp .env.example .env     # fill in BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET
npm run db:up            # MongoDB on 27017 and mongo-express on http://localhost:8081
npm run start:dev        # the first PvP sweep runs at startup
```

The repository's `.npmrc` holds only the registry line and must never hold a token.

Mythic+ and raid jobs are off by default. To try them, set `RAIDER_IO_API_KEY` and turn on
`MPLUS_ENABLED`, `MPLUS_ARCHIVE_ENABLED`, `RAID_CATALOGUE_ENABLED` and `RAID_RANKINGS_ENABLED`
in `.env`. Production runs with everything on.

`npm run db:check` shows what has been collected so far.

## Configuration

Everything is configured through environment variables, validated when the service
starts: a missing or malformed value stops it with a message naming the variable.
[`.env.example`](.env.example) lists and explains every one. The ones you are most likely
to touch:

| Variable                                            | Default         | Purpose                                                         |
| --------------------------------------------------- | --------------- | --------------------------------------------------------------- |
| `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET`      | —               | Blizzard API credentials                                        |
| `RAIDER_IO_API_KEY`                                 | empty           | Needed for Mythic+ and raids                                    |
| `MONGODB_URI`, `MONGODB_DB`                         | —, `rankwarden` | Database; a user and password go inside the URI                 |
| `BLIZZARD_REGIONS`, `RAIDERIO_REGIONS`              | all             | Regions to collect                                              |
| `INGEST_RUN_ON_STARTUP`                             | `true`          | Run a PvP sweep at startup                                      |
| `*_ENABLED`                                         | see example     | Switch each job on or off                                       |
| `LOG_LEVEL`                                         | `log`           | `error`, `warn`, `log`, `debug` or `verbose`                    |
| `DB_SCHEMA_MODE`                                    | `ensure`        | `ensure` builds the database structure at startup; `verify` only checks it (production) |
| `SEASON_PURGE_DRY_RUN`                              | `true`          | Log which finished season would be removed instead of removing it |

Upstream hosts and endpoint paths are settings too (`BLIZZARD_PATH_*`, `RAIDERIO_PATH_*`), so
an address change upstream can be fixed without a new release. Production values live in
[`deploy/helm/rankwarden/env/production.env`](deploy/helm/rankwarden/env/production.env).

## The data

All data lives in one MongoDB database, `rankwarden`, in 25 collections:

| Group             | Collections                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------- |
| PvP, live         | `characters`; `2v2_ratings`, `3v3_ratings`, `rbg_ratings`, `shuffle_ratings`, `blitz_ratings`; `spec_representation`; `season_state` |
| PvP, history      | `archive_entries`, `archive_seasons`, `archive_brackets`, `season_transitions`                |
| Mythic+, live     | `mplus_runs`, `mplus_characters`, `mplus_affixes`, `mplus_spec_representation`                |
| Mythic+, seasons  | `mplus_seasons`, `mplus_dungeons`, `mplus_season_state`, `mplus_season_transitions`           |
| Mythic+, history  | `mplus_archive_runs`, `mplus_archive_characters`                                              |
| Raids             | `raids`, `guilds`                                                                             |
| Internal          | `quota_windows`                                                                               |

A few things to know before reading it:

- **A PvP character is one document per season and region**, with every ladder they appear
  on inside it. The `*_ratings` collections hold one row per rating and are what ladders
  are sorted from; Solo Shuffle and Blitz list a character once per spec they play.
- **When querying `characters.ratings.<ladder>`, always add `{ $gt: 0 }`.** Without it,
  players who are not on that ladder sort to the top.
- **Mythic+ characters are a separate collection** with a different id from Blizzard's.
  Match the two on region, realm and lowercased name.
- **A Mythic+ score never goes down.** It is the sum of each character's best run per
  dungeon among the runs collected.

The field-by-field description of every collection is in [`SKILLS.md`](SKILLS.md) §5.

The database structure (collections and indexes) is declared in code and created by a
separate schema step (`npm run build && npm run db:schema`). Locally the service does this itself at startup;
in production a job does it before each release, and the service only checks it.

## HTTP endpoints

The service listens on port 3000. None of the endpoints are public in production.

| Endpoint                          | Purpose                                                                             |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `GET /health`                     | Is the process alive. Never touches a dependency                                    |
| `GET /health/ready`               | Should it receive traffic: database, upstreams, quotas, job progress. 503 only when MongoDB is down |
| `GET /health/seasons`             | Current seasons and what the next purge would remove                                |
| `POST /characters/sync`           | Replace a tracked PvP character's ladders and profile                               |
| `POST /mplus/characters/sync`     | Merge runs and profile into a tracked Mythic+ character                             |
| `POST /admin/<job>`               | Run one cycle of a job now. Development only: every admin route answers 404 in production |

The sync endpoints never create characters, and answer 409 while the job that owns those
documents is running. Request shapes and rules are in [`SKILLS.md`](SKILLS.md) §7.

## Logging and health

Logging and dependency health come from the shared package
[`@denipetrov/spirit-link`](https://github.com/denipetrov/spirit-link), used by every service
in this project family.

- **Logs** go to standard output in NestJS's format. Every line written during a job run is
  tagged with the run, for example `[sweep a1b2c3]`, so one run can be followed through a day
  of logs. Credentials are removed from anything logged or reported.
- **In production** a collector in the cluster forwards every pod's output to Grafana Cloud,
  where it can be searched by app and by level.
- **Health** is observed from real traffic, per upstream and region, rather than by probing
  the upstreams. Blizzard or Raider.io being down marks the service degraded; only MongoDB
  being down marks it not ready.

## Testing

```bash
npm test            # unit tests: no database needed, about 2 seconds
npm run db:up
npm run test:int    # integration tests: the real application against MongoDB and fake upstreams
```

The integration tests boot the whole application against fake Blizzard and Raider.io
servers that reproduce the real payloads, and check about 30 data invariants after each
scenario. They only ever use databases named `rankwarden_test_*`, so they cannot touch your
development data, and they cannot reach the real APIs.

CI runs typecheck, lint, formatting, build, both test suites, a check of the production
configuration, Helm chart linting and an image build.

## Deployment

Production runs on DigitalOcean Kubernetes in Frankfurt, with MongoDB in the same cluster,
daily backups to DigitalOcean Spaces, and logs in Grafana Cloud. A release is:

```bash
git tag v1.0.0 && git push origin v1.0.0     # builds and publishes the image
bash deploy/scripts/deploy.sh v1.0.0         # log collector, database, schema step, service
```

The first deployment, credentials, backups, restores and day-to-day operations are
described in [`deploy/README.md`](deploy/README.md).

## Project layout

```
src/
  main.ts, app.module.ts   startup and composition
  config/                  every setting, validated
  database/                MongoDB connection, collection names, schema (collections and indexes)
  common/                  job coordinator, quota budgets, events, shared utilities
  blizzard/, raiderio/     the two upstream clients and their payload schemas
  leaderboard/             PvP sweep: characters and ratings
  profile/                 PvP character profiles
  representation/          daily PvP spec popularity
  season/                  PvP seasons and retiring finished ones
  archive/                 PvP season history and title cutoffs
  mplus/, mplus-season/,
  mplus-archive/,
  mplus-representation/    Mythic+ runs, seasons, history and spec usage
  raid/                    raid catalogue, rankings and guilds
  sync/, health/, admin/   HTTP endpoints
test/                      integration tests and the fake upstreams
scripts/                   database report and live verification tools
deploy/                    Helm charts and deployment scripts
Dockerfile                 the production image
```

## Development notes

- **ESM project.** Relative imports end in `.js`, even in TypeScript.
- **No ORM.** MongoDB is used through its official driver.
- **Debugging in VS Code.** `.vscode/launch.json` has configurations to debug the app, the
  app without the startup sweep, a single test file, and to attach to a running process.
- **Changing behaviour?** Read [`SKILLS.md`](SKILLS.md) first. It is the complete technical
  reference: every job, every collection field, every endpoint rule, and the data traps that
  produce wrong numbers when forgotten.

## Documentation

| File                                   | For                                                          |
| -------------------------------------- | ------------------------------------------------------------ |
| `README.md`                            | This overview                                                |
| [`SKILLS.md`](SKILLS.md)               | The full technical reference, and the rules for AI agents working on the code |
| [`deploy/README.md`](deploy/README.md) | Deploying and operating the service                          |
| [`.env.example`](.env.example)         | Every setting, explained                                     |
