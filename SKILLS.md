# Rankwarden — capabilities reference

Ingestion service for World of Warcraft PvP data. It pulls leaderboards and character
detail from the Blizzard Game Data API, keeps them in MongoDB in shapes tuned for the
queries a front end actually makes, and maintains a daily record of specialisation
representation plus an archive of finished seasons.

This document is written for agents that need to test or extend the service. It covers
what exists, why it is shaped that way, and the domain traps that are easy to
reintroduce. Read [Domain rules](#domain-rules-and-traps) before changing ingestion or
aggregation logic — several of those rules were found by observing wrong data, not by
reading the API docs.

---

## 1. Stack and hard constraints

|             |                                                                    |
| ----------- | ------------------------------------------------------------------ |
| Runtime     | Node ≥ 22 (developed on 26), **ESM** (`"type": "module"`)          |
| Framework   | NestJS 12                                                          |
| HTTP client | got 16 (ESM-only — this is why the project is ESM)                 |
| Validation  | zod 4                                                              |
| Database    | MongoDB 8 via the official `mongodb` driver 7 (no ODM)             |
| Tests       | Vitest 4, transformed through SWC so `emitDecoratorMetadata` works |
| Auth        | `@denipetrov/blizz-auth` (private, GitHub Packages)                |

**Relative imports must carry the `.js` extension.** `module: nodenext` requires it. A
missing extension fails at runtime, not at compile time.

`@denipetrov/blizz-auth` resolves through `.npmrc` (`@denipetrov:registry=https://npm.pkg.github.com`)
and needs a token with `read:packages`:

```bash
npm config set //npm.pkg.github.com/:_authToken=$(gh auth token)
```

---

## 2. Getting a working environment

```bash
npm install
cp .env.example .env       # fill BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET
npm run db:up              # mongo:8 + mongo-express on 27017 / 8081
npm run start:dev
```

Credentials come from https://develop.battle.net/access/clients. Without them the app
exits at boot with a zod error naming the missing variables — that is by design.

| Command                                  | Purpose                                                  |
| ---------------------------------------- | -------------------------------------------------------- |
| `npm test` / `test:watch` / `test:cov`   | Vitest (86 tests, 13 files)                              |
| `npm run typecheck`                      | `tsc --noEmit`                                           |
| `npm run lint` / `format`                | ESLint / Prettier                                        |
| `npm run build` / `start:prod`           | Compile to `dist/`, run compiled output                  |
| `npm run db:up` / `db:down` / `db:reset` | Start / stop stack; `db:reset` drops the volume          |
| `npm run db:check`                       | Connectivity plus a full ingestion report                |
| `npm run db:shell`                       | `mongosh` inside the container                           |
| `npm run db:migrate`                     | One-off legacy `leaderboard_entries` → `characters` fold |

`.vscode/launch.json` has seven debug configurations, including one that boots with
`INGEST_RUN_ON_STARTUP=false` so a sweep can be stepped through deliberately.

---

## 3. Module map

```
src/
  main.ts                     bootstrap, log level, shutdown hooks
  app.module.ts               composition root
  config/                     zod env schema, global config module
  common/
    ingestion-coordinator.service.ts   job priority + warm-up gate
    events/sweep-events.service.ts     rxjs Subject for "sweep finished"
    pipes/zod-validation.pipe.ts       request body validation
    utils/concurrency.ts               bounded parallel map
    utils/rate-limiter.ts              token bucket
  blizzard/
    blizzard.constants.ts       regions, brackets, families, exclusions
    auth/                       token provider seam + blizz-auth adapter
    http/                       shared got instance, typed BlizzardApiError
    schemas/                    zod schemas for every payload consumed
    pvp.api.ts                  season index/detail, bracket index, leaderboards
    profile.api.ts              character summary + specializations
  season/                       active season per region, daily refresh
  leaderboard/                  the sweep, character + rating repositories
  profile/                      background profile enrichment
  representation/               daily spec-representation snapshots
  archive/                      finished seasons, fetched once
  sync/                         POST /characters/sync
  health/                       GET /health
scripts/db-check.mjs            standalone ingestion report
scripts/migrate-to-characters.mjs
```

---

## 4. Background jobs and their priority

Four jobs run on intervals. They compete for one hourly API quota and, in part, for the
same documents, so [`IngestionCoordinator`](src/common/ingestion-coordinator.service.ts)
ranks them:

| Priority | Job                     | Cadence                                                          | Yields to                |
| -------- | ----------------------- | ---------------------------------------------------------------- | ------------------------ |
| 1        | **Leaderboard sweep**   | `INGEST_INTERVAL_MS` (1h)                                        | nothing                  |
| 2        | **Profile enrichment**  | `PROFILE_INTERVAL_MS` (5m) + after each sweep                    | the sweep                |
| 3        | **Spec representation** | `REPRESENTATION_CHECK_INTERVAL_MS` (1h), writes once per UTC day | the sweep                |
| 4        | **Season archive**      | `ARCHIVE_CHECK_INTERVAL_MS` (1h)                                 | sweep **and** enrichment |
| —        | **Season refresh**      | `SEASON_REFRESH_INTERVAL_MS` (1d)                                | nothing (2 requests)     |
| —        | **Season transition**   | `SEASON_TRANSITION_CHECK_INTERVAL_MS` (1h) + on every rollover   | nothing (no API calls)   |

The coordinator exposes `isSweepActive`, `isEnrichmentActive`, `isLiveIngestionActive`,
`isWarmedUp`, and `warmedUp$`. `duringSweep()` / `duringEnrichment()` wrap the work.

**Warm-up gate.** The archive does not tick at bootstrap. It subscribes to `warmedUp$`,
which fires once the first sweep _and_ first enrichment pass have both completed.
`markEnrichmentDisabled()` releases the gate when enrichment is switched off — without it
the archive would wait forever for a pass that never comes.

### 4.1 Leaderboard sweep

`LeaderboardService.sweep()` — the live data path.

1. Per region: refresh the season, then ask the API which brackets exist
   (`GET /pvp-season/{id}/pvp-leaderboard/index`). **Never hardcode the bracket list.**
2. Filter out `EXCLUDED_BRACKETS`, expand to `region × bracket` jobs (currently 332).
3. Run them through `mapWithConcurrency` at `BLIZZARD_CONCURRENCY` (8).
4. Each job: fetch → zod-validate → map → upsert into `characters` → mirror into the
   family's ratings collection → prune that bracket in both.
5. Once per region afterwards: `removeUnranked`, `removeOrphans`, `removeRetiredBrackets`.
6. Emit `SweepEvents.completed$` **after** the coordinator releases.

Observed: 332/332 brackets in ~35s.

**Overlapping sweeps are skipped, not queued.** The post-sweep cleanup takes its season id
from the jobs it built, not from `SeasonService` — a rollover detected mid-sweep would
otherwise clean the new season while every write went to the old one.

### 4.2 Profile enrichment

`ProfileEnrichmentService.run(onlyNew?)` — fills race, class, spec, hero talents, realm
name, title, guild, item level, last login.

Two endpoints with **separate TTLs**, because they age differently:

| Half            | Fields                                              | TTL                           | Timestamp          |
| --------------- | --------------------------------------------------- | ----------------------------- | ------------------ |
| Summary         | race, class, realm, title, guild, level, item level | `PROFILE_SUMMARY_TTL_MS` (7d) | `profileFetchedAt` |
| Specializations | spec, hero tree, talent loadouts                    | `PROFILE_SPECS_TTL_MS` (1d)   | `specsFetchedAt`   |

Only the due halves are fetched, so a refresh costs one request rather than two. Writes
are field-level (`profile.race`, `profile.spec`, …) so the halves never clobber each other.

Selection is `specsFetchedAt` ascending. Specs have the shorter TTL, so anything due for a
summary refresh is necessarily due for specs too — one timestamp paces the queue. The
field is absent until first enrichment, and absent sorts before any date, so newcomers win.
A finished sweep also fires an immediate **new-characters-only** pass.

**Every outcome stamps a timestamp.** This is load-bearing, not housekeeping: selection
sorts by `specsFetchedAt` ascending and an absent field sorts before every date, so a
character that fails without being stamped is re-selected on every pass forever — and once
enough of them fill a batch, nothing else is ever enriched again while the job goes on
reporting successful runs.

| Outcome           | Written                                                         | Retried |
| ----------------- | --------------------------------------------------------------- | ------- |
| 404               | `profileStatus: 'missing'`, both timestamps, `profile` unset    | no      |
| schema failure    | `profileStatus: 'unparseable'`, the failing half stamped as now | one TTL |
| transient failure | the failing half backdated to `TTL - PROFILE_RETRY_BACKOFF_MS`  | ~15m    |

A schema failure is deterministic, so it waits out the full TTL; anything else could be a
blip and comes back sooner. The backoff is expressed by backdating the timestamp rather
than carrying another field and another index. Stored profile data survives both — unlike a
404 the character still exists, and stale-but-real beats nothing.

### 4.3 Spec representation

`SpecRepresentationService.snapshot()` — one row per UTC day per region/family/cutoff.

A tick checks whether the current UTC day already has a snapshot; if not it computes one.
That is deliberately not a fixed daily alarm — a restart or outage cannot silently lose a
day, and re-running upserts. Ticks also fire on sweep completion, which is what covers
startup: the bootstrap tick always lands while the startup sweep holds the coordinator.

Each run also purges snapshots predating the current season, **per region** (season starts
differ by up to 32 hours between regions).

### 4.4 Season archive

`ArchiveService` — finished seasons, fetched once, stored separately.

`nextPending()` walks regions × finished seasons (newest first, bounded by
`ARCHIVE_MIN_SEASON` / `ARCHIVE_MAX_SEASON`) and returns the first that is neither complete
nor known unfetchable.

For a season with **no marker at all** — a crash mid-season, or a dropped `archive_seasons`
collection — it first tries to recover one: it compares the brackets already covered (§5.4)
against the list the API publishes, and writes the marker back if they match, turning ~83
requests into one. A shortfall is recorded as `failedBrackets` and the season stays pending.

Recovery runs **only** when no marker exists. A marker naming outstanding brackets is an
explicit record of what failed, and re-deriving completeness from the data would overrule
it. The retry is cheap regardless, because `archiveSeason` fetches only what is genuinely
outstanding.

The scheduler takes one season per pass and comes straight back while work remains, pausing
`ARCHIVE_SEASON_PAUSE_MS` between seasons. A season that 404s is marked `unarchivable` and
skipped permanently, so one dead season cannot block the backlog behind it; any other
failure is skipped for the rest of that tick only.

### 4.5 Season refresh

`SeasonScheduler` re-reads the active season daily, independently of sweeps, so a rollover
is caught even when ingestion is disabled or failing. Logs two distinct warn-level
transitions: a season **ending** and a **rollover**, and publishes both on
`SeasonEvents.transitions$`.

State is **persisted** in `season_state` and rehydrated in `SeasonService.onModuleInit()`.
This is not a cache optimisation: without it `previous` is `undefined` on a fresh process,
so a rollover that happened while the service was down took the "first observation" branch
and was never recognised as a rollover at all. The transition purge hangs off that
comparison, so the persisted copy is what makes a rollover across a restart detectable.

### 4.6 Season transition (retiring a finished season)

`SeasonTransitionService` removes a finished season from the live collections **once the
next season actually begins** — not when the old one ends, so the boards stay readable
through the gap between seasons.

- `plan(now)` is read-only and exposed on `GET /health/seasons`. It abstains if any
  configured region has never been observed (one region failing at boot must not look like
  a rollover), and again if `now` is before `transitionAt`.
- `transitionAt` = the earliest `startsAt` among the regions already on the newest season.
- The delete is scoped **per region** to `seasonId < current(R)`. Regions stagger by up to
  32 hours; deleting every region at the earliest start would empty a trailing region's
  live board, its next sweep would rewrite it, and the next tick would remove it again.
- `SEASON_PURGE_REQUIRE_ARCHIVE` (default on) holds back any season the archive does not
  hold in full — after a purge the archive is the only surviving copy.
- `SEASON_PURGE_DRY_RUN` logs the full plan and deletes nothing. **Defaults to `true`**,
  unlike every other flag, so deleting is an explicit opt-in (see the hazard below).
- Order within `purge()`: ratings rows → characters → spec_representation → marker. Rating
  rows go first so invariant "no orphan rating rows" holds at every intermediate moment,
  not only at the end.

> **Deployment hazard.** On a first deploy mid-season the gate is _already open_, because
> `transitionAt` is the current season's start and that is in the past. Any archived season
> below the current one is then purged on the first tick — at boot, not at the next
> rollover. Ship with `SEASON_PURGE_DRY_RUN=true`, read the logged plan, then flip it.

---

## 5. Data model

### 5.1 `characters` — one document per character per season+region

```js
{
  seasonId: 42, region: 'us', characterId: 195802602,
  characterName: 'Goküü', realmId: 61, realmSlug: 'emerald-dream', faction: 'HORDE',

  brackets: {                                    // full payload, never indexed
    '3v3':               { rank, rating, played, won, lost, fetchedAt },
    'shuffle-mage-fire': { rank, rating, played, won, lost, fetchedAt },
  },
  ratings: { '3v3': 2093, 'shuffle-mage-fire': 2688 },   // indexed mirror
  updatedAt: Date,

  profile: {                                     // enrichment only
    race: { id, name }, class: { id, name }, spec: { id, name },
    heroTalentTree: { id, name } | null,
    talentLoadouts: [{ spec: {id,name}, talentLoadoutCode: string|null,
                       heroTalentTree: {id,name}|null }],
    realmName, title, level, gender, guild,
    averageItemLevel, equippedItemLevel, lastLoginAt,
  },
  profileStatus: 'ok' | 'missing' | 'unparseable',
  profileFetchedAt: Date,   // summary half
  specsFetchedAt: Date,     // spec half
}
```

Indexes: `character_identity` (unique `seasonId+region+characterId`), `character_lookup`
(`characterName+realmSlug`), `profile_staleness`, `specs_staleness`, and **`bracket_ratings`**
— a compound wildcard `{ seasonId: 1, region: 1, 'ratings.$**': 1 }`.

> **Why the wildcard.** MongoDB caps a collection at 64 indexes; one per bracket would need
> 85+. Mirroring only `rating` (the sole searchable field) into a flat map lets a single
> index serve every bracket. Measured on 138k documents: 50 keys / 50 docs examined,
> index-ordered, no blocking sort — for core _and_ per-spec ladders — from one 2.3MB index.

### 5.2 Ratings collections — one row per rating

`2v2_ratings`, `3v3_ratings`, `rbg_ratings`, `shuffle_ratings`, `blitz_ratings`

```js
{
  (seasonId, region, bracket, characterId, rating, fetchedAt);
}
```

Core brackets give a character one row; shuffle and blitz give one row **per spec played**.
That is the point: an "all classes, all specs" board must list a character once per spec.

Indexes: `board_order` (`seasonId+region+rating desc`), `entry_identity` (unique
`seasonId+region+bracket+characterId`), `character`.

```js
db.shuffle_ratings.find({ seasonId: 42, region: 'us' }).sort({ rating: -1 }).limit(50);
// 50 keys / 50 docs, index-ordered; ~12ms including a $lookup into characters
```

### 5.3 `spec_representation` — daily FOTM snapshot

```js
{ date: <UTC midnight>, seasonId, region, family, minRating,
  total: 8248,        // characters/rows at or above the cutoff
  classified: 8248,   // of those, with a known spec
  specs: [
    { class: 'priest', spec: 'holy', count: 825, share: 0.1000,
      heroTalentsClassified: 7,
      heroTalents: [{ id: 42, name: 'Oracle', count: 7, share: 1.0 }] },
  ],
  computedAt }
```

`class`/`spec` are Blizzard's own slugs (`Death Knight` → `deathknight`), so a spec from a
profile and one from a bracket name resolve to the same key. A spec's `share` is a fraction
of `classified`; a hero talent's `share` is a fraction of that spec's `heroTalentsClassified`.

Indexes: `snapshot_identity` (unique), `series` (the time-series read, ~1ms).

### 5.4 Archive — `archive_entries` + `archive_seasons` + `archive_brackets`

```js
// archive_entries — the standings themselves
{ seasonId, region, bracket, characterId, characterName, realmId, realmSlug,
  faction, rank, rating, played, won, lost }

// archive_seasons — the run-once marker
{ seasonId, region, name, startsAt, endsAt, brackets, entries,
  failedBrackets: [], archivedAt, unarchivable?, lastError? }

// archive_brackets — what was fetched, whatever it contained
{ seasonId, region, bracket, entries, fetchedAt }
```

Archive rows are **self-contained** — no reference into `characters`. Historical standings
must keep reading correctly forever, and a character can be renamed, transferred or deleted
long after the season it played in. No profile enrichment: it costs two requests per
character and would describe the player _today_, not during that season.

**Why `archive_brackets` exists.** Completeness used to be inferred from stored rows, which
cannot tell a ladder nobody qualified for from one that was never fetched — both store
nothing. On a small region plenty of the 80 spec ladders finish a season empty, so such a
season could never be adopted from its rows and the cheap recovery path was defeated exactly
where it mattered. Recording the fetch removes the inference. It is a separate collection so
`archive_entries` stays purely the standings and needs no filtering, and so the record
survives losing `archive_seasons`.

Coverage is `archive_brackets ∪ rows`. The union matters: the fetch record is written after
the rows, so a crash between the two leaves rows that still count. Seasons archived before
the collection existed have no records, so their rows stand in — the old inference, with the
old blind spot, but far better than treating archived history as missing.

Indexes: `archive_board`, `archive_identity` (unique), `archive_character`, and
`bracket_identity` (unique) on `archive_brackets`.

---

## 6. Blizzard API surface

All calls go through `BlizzardHttpService`: one shared got instance, bearer auth injected
per request, retries on 408/429/5xx, namespace and locale applied automatically.
Non-2xx becomes `BlizzardApiError` with `statusCode` and `isNotFound`.

| Endpoint                                                | Namespace | Used by                                      |
| ------------------------------------------------------- | --------- | -------------------------------------------- |
| `/data/wow/pvp-season/index`                            | dynamic   | current + last completed season, season list |
| `/data/wow/pvp-season/{id}`                             | dynamic   | start/end timestamps, name                   |
| `/data/wow/pvp-season/{id}/pvp-leaderboard/index`       | dynamic   | bracket list                                 |
| `/data/wow/pvp-season/{id}/pvp-leaderboard/{bracket}`   | dynamic   | the ladder                                   |
| `/profile/wow/character/{realm}/{name}`                 | profile   | race, class, realm, title, guild             |
| `/profile/wow/character/{realm}/{name}/specializations` | profile   | spec, hero tree, loadouts                    |

**Quota: 100 requests/second, 36,000/hour.** Everything else follows from that.

Namespaces are derived per endpoint (`namespaceFor('profile', 'eu')` → `profile-eu`), not
configured. Character names must be lowercased and percent-encoded (`Zëph`).

---

## 7. HTTP endpoints

### `GET /health` — liveness

Process-local only: no database command, no upstream call. It answers under any dependency
outage and cannot time out behind one, so a slow dependency can never get a healthy process
killed. **Always 200 while the process is up.**

```json
{
  "status": "ok",
  "uptimeSeconds": 20,
  "sweepRunning": false,
  "seasons": { "us": { "id": 42, "name": "…", "startsAt": "…", "endsAt": null } },
  "jobs": {
    "sweepRunning": false,
    "enrichmentRunning": false,
    "warmedUp": true,
    "lastSweep": { "finishedAt": "…", "brackets": 332, "failed": 0, "removedCharacters": 41 }
  }
}
```

### `GET /health/ready` — readiness

Pings Mongo (cached ~3s) and reports what real traffic has already observed of Blizzard,
**per region**. This is what an orchestrator should poll.

| Condition                            | `status`   | HTTP    |
| ------------------------------------ | ---------- | ------- |
| everything healthy                   | `ok`       | **200** |
| Blizzard failing (any/all regions)   | `degraded` | **200** |
| no sweep for 2× `INGEST_INTERVAL_MS` | `degraded` | **200** |
| Mongo unreachable                    | `down`     | **503** |

Mongo is a **hard** dependency and Blizzard a **soft** one. Without Mongo the service can
do nothing, so readiness fails and traffic should be withdrawn. Without Blizzard it still
holds every row already ingested, so only ingestion is degraded — failing readiness there
would have an orchestrator restart-loop the service through an incident it cannot fix.
**Do not "fix" the Blizzard case into a 503.**

Two further rules this endpoint must keep:

- **Never probe Blizzard.** State is recorded passively by `BlizzardHttpService` on real
  calls. The endpoint is unauthenticated, so an active probe per hit would be free
  amplification into a metered third-party API.
- **Never leak a credential.** The Mongo host is reported, never the URI, and every
  reported string passes through `redactSecrets` — driver connection errors routinely echo
  the whole connection string.

### `GET /health/seasons`

Per-region season detail plus the read-only season-transition `plan()`. Kept off the
readiness path because it reads the database.

### `POST /admin/*` — dev-only job triggers

`sweep`, `enrich`, `snapshot`, `archive`, `season-refresh`, `season-transition`. Each drives
exactly **one** cycle and returns that cycle's own result object. Every route **404s when
`NODE_ENV=production`**.

They exist because the alternative — shrinking the intervals through configuration — makes
every job race every other one, so a runtime rehearsal stops being a controlled
observation.

### `POST /characters/sync`

Push a whole character record so a search API can keep all three collections consistent
without waiting for the next sweep.

```http
{ "seasonId": 42, "region": "us", "characterId": 195802602,
  "characterName": "Goküü", "realmId": 61, "realmSlug": "emerald-dream",
  "faction": "HORDE",
  "brackets": { "3v3": { "rank": 119, "rating": 2093, "played": 10, "won": 5, "lost": 5 } },
  "profile": { … } }
→ 200 { "brackets": 1, "ignoredBrackets": [], "ratingRows": { … } }
```

| Response | Meaning                                                                 |
| -------- | ----------------------------------------------------------------------- |
| 200      | Written                                                                 |
| 400      | Invalid payload (every offending field listed), or no storable brackets |
| 404      | No such character — **the endpoint never creates one**                  |
| 409      | A sweep is running; retry when it finishes (~35s)                       |

Semantics that will bite a caller:

- **`brackets` is authoritative for every bracket at once.** A bracket absent from the
  payload means "the character left that ladder" and its rating row is deleted. Sending a
  subset deletes the rest. Send the whole document.
- **`profile` is merged field by field.** Absent leaves the stored value; explicit `null`
  clears it. Only the halves supplied get their enrichment timestamp stamped.
- `ratings` is **not accepted** — it is recomputed from `brackets`, which is the only way
  the mirror cannot drift. Unknown keys are stripped, so a document read from Mongo can be
  posted back unchanged.
- The 409 is a check, not a lock. A sweep starting microseconds later would overwrite the
  push with fresher data — the harmless direction.

**No authentication.** It mutates data and is open on the configured port. Put a shared
secret or network policy in front of it before it runs anywhere but localhost.

---

## 8. Configuration

Every variable is validated by zod at boot; anything missing or malformed fails fast.

| Variable                              | Default                             | Notes                                            |
| ------------------------------------- | ----------------------------------- | ------------------------------------------------ |
| `BLIZZARD_CLIENT_ID` / `_SECRET`      | —                                   | **Required**                                     |
| `BLIZZARD_REGION`                     | `us`                                | OAuth host region only (`us,eu,kr,tw,cn`)        |
| `BLIZZARD_REGIONS`                    | `us,eu,kr,tw`                       | Ladders to ingest — distinct from the above      |
| `BLIZZARD_LOCALE`                     | `en_US`                             |                                                  |
| `BLIZZARD_API_HOST_TEMPLATE`          | `https://{region}.api.blizzard.com` | Must contain `{region}`; the L3 test seam        |
| `BLIZZARD_REQUEST_TIMEOUT_MS`         | `30000`                             |                                                  |
| `BLIZZARD_RETRY_LIMIT`                | `3`                                 |                                                  |
| `BLIZZARD_CONCURRENCY`                | `8`                                 | Parallel bracket fetches per sweep               |
| `MONGODB_URI`                         | —                                   | **Required**                                     |
| `MONGODB_DB`                          | `rankwarden`                        |                                                  |
| `INGEST_INTERVAL_MS`                  | `3600000`                           |                                                  |
| `INGEST_RUN_ON_STARTUP`               | `true`                              |                                                  |
| `PROFILE_ENRICHMENT_ENABLED`          | `true`                              | `false` releases the archive warm-up gate        |
| `PROFILE_INTERVAL_MS`                 | `300000`                            |                                                  |
| `PROFILE_BATCH_SIZE`                  | `500`                               | Characters per pass                              |
| `PROFILE_SUMMARY_TTL_MS`              | `604800000`                         | 7 days                                           |
| `PROFILE_SPECS_TTL_MS`                | `86400000`                          | 1 day                                            |
| `PROFILE_CONCURRENCY`                 | `8`                                 |                                                  |
| `PROFILE_RETRY_BACKOFF_MS`            | `900000`                            | Wait after a transient enrichment failure        |
| `PROFILE_REQUESTS_PER_SECOND`         | `20`                                | Token bucket                                     |
| `SEASON_REFRESH_ENABLED`              | `true`                              | Off switch for the daily season re-check         |
| `SEASON_REFRESH_INTERVAL_MS`          | `86400000`                          |                                                  |
| `SEASON_TRANSITION_ENABLED`           | `true`                              | Retiring finished seasons                        |
| `SEASON_TRANSITION_CHECK_INTERVAL_MS` | `3600000`                           | A rollover also ticks immediately                |
| `SEASON_PURGE_REQUIRE_ARCHIVE`        | `true`                              | Only purge what the archive holds in full        |
| `SEASON_PURGE_DRY_RUN`                | `true`                              | Log the plan, delete nothing; set `false` to arm |
| `REPRESENTATION_ENABLED`              | `true`                              |                                                  |
| `REPRESENTATION_CHECK_INTERVAL_MS`    | `3600000`                           |                                                  |
| `REPRESENTATION_MIN_RATINGS`          | `1500,1800,2100,2300,2700`          | Cutoffs to track                                 |
| `ARCHIVE_ENABLED`                     | `true`                              |                                                  |
| `ARCHIVE_CHECK_INTERVAL_MS`           | `3600000`                           |                                                  |
| `ARCHIVE_SEASON_PAUSE_MS`             | `5000`                              | Breather between seasons                         |
| `ARCHIVE_CONCURRENCY`                 | `4`                                 |                                                  |
| `ARCHIVE_REQUESTS_PER_SECOND`         | `10`                                |                                                  |
| `ARCHIVE_MIN_SEASON` / `_MAX_SEASON`  | `0` / `0`                           | 0 = unbounded; the real size lever               |
| `ARCHIVE_MAX_ENTRIES_PER_BRACKET`     | `5000`                              | Top N by rating; saves only ~1%                  |
| `NODE_ENV` / `PORT` / `LOG_LEVEL`     | `development` / `3000` / `log`      |                                                  |

---

## 9. Domain rules and traps

These cost real debugging. Violating them produces data that looks plausible and is wrong.

### 9.1 `shuffle-overall` and `blitz-overall` are excluded

Solo Shuffle and Blitz are rated **per specialisation**. The aggregate board does not track
a character's best spec: one character ranks 1st in `shuffle-mage-fire` at 2688 while their
overall reads 2454 — their _frost_ rating. Measured, **748 of 11,105** characters had a spec
rating higher than their overall, by up to 2006 points.

They are in `EXCLUDED_BRACKETS`, skipped at `buildJobs`, rejected by `ratingFamilyOf`,
rejected by the sync endpoint, and purged from existing documents at startup.

**Consequence:** there is no single "shuffle rating" per character. A UI must pick — best
spec, or the one matching `profile.spec`.

### 9.2 Hero talents must correlate with the ladder's spec

`profile.heroTalentTree` is the **active spec's** tree. Using it for a character on another
spec's ladder produces combinations the game forbids — a Fury warrior's Mountain Thane
credited to the Arms ladder.

Always read the tree from `profile.talentLoadouts`, matching the ladder's spec. Measured,
**5 of 6** characters ranked on a non-active spec's ladder were mis-attributed the other way.

The same applies to talent codes: every spec has its own `is_active` loadout, so a flat scan
of the payload mixes builds.

### 9.3 `$gt: 0` is required on every rating query

Characters who do not play a bracket have no key for it; missing fields index as `null`, and
`null` sorts before every number. Omitting the predicate silently returns players from other
brackets at the top of the ladder.

| Predicate           | Keys examined | Time           |
| ------------------- | ------------- | -------------- |
| `{ $gt: 0 }`        | 50            | 0ms            |
| `{ $exists: true }` | 11,032        | 20ms           |
| _(omitted)_         | 50            | **wrong rows** |

Use `$gt: 0`, never `$exists: true` — the latter cannot be resolved from index bounds.

### 9.4 Paginate with a rating cursor, not `skip`

`skip: 5000` examines 5,050 keys. `rating: { $lt: lastSeen }` stays at 50 at any depth.

### 9.5 Blizzard payload shapes are inconsistent

| Field                  | Shapes observed                                                           | Handling                                        |
| ---------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| `leaderboards[].id`    | present on the **first** entry only                                       | `.optional()`; key off `name`                   |
| `season_name`          | string (39), absent (33), **null** (40)                                   | `.nullish()` — `.optional()` alone rejects null |
| `season_end_timestamp` | absent while running, appears **on the same record** when the season ends | re-read while null, then cache forever          |
| `active_title`         | absent when none equipped                                                 | `.optional()`, store `display_string`           |

A too-strict schema fails the _whole_ parse. That is preferable to silent partial ingestion,
but it means new seasons can break a job — validate against a real payload before shipping
a schema change.

### 9.6 Spec coverage is not uniform

| Dimension    | Family         | Source                            | Coverage                     |
| ------------ | -------------- | --------------------------------- | ---------------------------- |
| class + spec | shuffle, blitz | bracket name                      | **100%** immediately         |
| class + spec | 2v2, 3v3, rbg  | enriched `profile.spec`           | as far as enrichment reached |
| hero talent  | **all**        | enriched `profile.heroTalentTree` | as far as enrichment reached |

The bracket name never carries the hero tree, so that level always depends on enrichment.
Snapshots therefore report `classified`/`total` and `heroTalentsClassified`/`count`. A
front end should gate on those ratios — early-season data has the shape of an answer with
none of the substance.

### 9.7 Concurrent upserts race on the identity index

Two brackets of the same region write the same character document, so an upsert can lose
the race on the unique index (E11000). `CharacterRepository.writeChunk` replays only the
losing operations, which then settle as plain updates. Anything that is not a duplicate-key
error still propagates.

### 9.8 Cleanup has five distinct paths

Run **in this order**, once per region, at the end of every sweep:

| #   | Cleanup                                                       | Removes                          | Case                       |
| --- | ------------------------------------------------------------- | -------------------------------- | -------------------------- |
| 1   | `CharacterRepository.pruneBracket` (per bracket, `fetchedAt`) | a bracket not refreshed          | character left that ladder |
| 2   | `CharacterRepository.removeRetiredBrackets`                   | bracket keys no longer published | a spec ladder disappears   |
| 3   | `CharacterRepository.removeUnranked`                          | characters ranking in nothing    | left every ladder          |
| 4   | `RatingRepository.removeOrphans` (vs `characters`)            | rows whose character is gone     | character deleted          |
| 5   | `RatingRepository.removeRetiredBrackets`                      | rows for unpublished brackets    | a spec ladder disappears   |

**The order matters twice.** Step 2 must precede step 3: a character ranked _only_ in
retired brackets never reaches an empty `brackets` map otherwise, so `removeUnranked` can
never see them and they persist for the rest of the season, still queryable through the
`bracket_ratings` wildcard index. And steps 4–5 must follow step 3, so the rows are
genuinely orphans by the time they are reconciled.

Both `removeRetiredBrackets` implementations **refuse to act on an empty bracket list** —
that means the sweep failed for the region, not that every ladder retired. Without the
guard a single failed region is wiped.

A sixth path, the season purge (§4.6), is separate: it retires a whole finished season and
is gated on the _next_ season starting, not on a sweep.

---

## 10. Testing

Two Vitest projects, because the layers have different prerequisites.

| Command            | Project       | Covers                                          | Needs   |
| ------------------ | ------------- | ----------------------------------------------- | ------- |
| `npm test`         | `unit`        | `src/**/*.spec.ts` — pure functions, mocked DI  | nothing |
| `npm run test:int` | `integration` | `test/**/*.spec.ts` — real Mongo, fake Blizzard | Docker  |
| `npm run test:all` | both          |                                                 | Docker  |

The integration project is deliberately out of `npm test`, so a push does not demand a
running container. Vitest runs through SWC in both, so Nest DI works.

### 10.1 Unit patterns

- **Pure functions** tested directly: `mapWithConcurrency`, `RateLimiter`, `toSlug`,
  `startOfUtcDay`, `activeLoadoutsBySpec`, `ratingFamilyOf`, `isIngestableBracket`,
  `describeError`, `redactSecrets`, `PendingWork`.
- **Services** via `Test.createTestingModule` with repositories and API clients replaced by
  `vi.fn()`. See `profile-enrichment.service.spec.ts` and `archive.service.spec.ts`.
- **`ConfigService`** stubbed as `{ get: (key) => env[key] }` over a plain object.
- **`IngestionCoordinator`** used real, not mocked — it is pure state, and its interaction
  with the service under test is the thing worth asserting.
- **`app.module.spec.ts`** compiles the whole graph without initialising it, which catches a
  provider missing from its module or a cycle between two modules.

### 10.2 The integration harness

Everything lives in `test/support/`:

| Piece              | Role                                                                     |
| ------------------ | ------------------------------------------------------------------------ |
| `world.ts`         | Mutable model of Blizzard. Scenarios are mutations to it between sweeps. |
| `specs.ts`         | The 40 real specialisations, so a world publishes the same 85 brackets.  |
| `fake-blizzard.ts` | Replaces `BlizzardHttpService`, serving the World as raw JSON.           |
| `app.ts`           | `bootTestApp` — real `AppModule`, real Mongo, fake Blizzard.             |
| `invariants.ts`    | `expectInvariants` and the individual I1–I10 checks.                     |
| `database.ts`      | Test database naming and the guard below.                                |
| `http.ts`          | `fetch` against a real listener; no supertest dependency.                |
| `seams.ts`         | Every scheduler whose bootstrap work can be awaited.                     |

**The fake sits at the HTTP seam, not at `PvpApi`.** That keeps `PvpApi`, `ProfileApi` and
every zod schema inside the test, which is where the payload traps of §9.5 live. The fake
reproduces them deliberately: `leaderboards[].id` on the first entry only, and
`season_end_timestamp` absent rather than null while a season runs.

### 10.3 Two rules the harness enforces

**One configuration per test file.** `ConfigModule.forRoot()` reads the environment when
`app.module.ts` is imported, and ESM caches that module for the file's lifetime — so a
second `bootTestApp` with different settings would silently reuse the first. Configuration
is applied through `process.env` _before_ the dynamic import, and a second boot that asks
for something different throws rather than misleading you. Rebooting with identical
configuration is fine, and is how the restart cases work.

**Never the development database.** `ConfigModule` falls back to `.env`, where `MONGODB_DB`
is the real database — so a test that boots `AppModule` without overriding it would have a
sweep write into live data. Every test database is named `rankwarden_test_<file>`, and
`assertTestDatabase` refuses anything without that prefix. `test/setup/integration-env.ts`
applies it before any module is imported, and also points `BLIZZARD_API_HOST_TEMPLATE` at a
dead port so a missed seam fails locally instead of spending real quota.

### 10.4 Awaiting background work

Schedulers start work from lifecycle hooks and timers, neither of which can await anything.
Each therefore exposes `whenSettled()`, and `TestApp.settle()` drains all of them.

This is not a convenience. `season_state` is written by exactly that un-awaitable call, so
without the seam a test polls for it or races it; and `app.close()` while a tick is mid-query
shuts MongoDB down underneath a live read, which surfaces as an intermittent "MongoClient
must be connected" that looks like a bug in the test. `TestApp.close()` drains before closing
for that reason.

### 10.5 What is still not covered

Repositories and aggregation pipelines have no _unit_ coverage — they are exercised through
the integration project instead. When changing a pipeline, verify against real data: one
that returns plausible numbers can still be wrong, as §9.2 shows. A useful technique is to
keep extra per-document detail in the pipeline, run it against Mongo, and compare old versus
new attribution side by side.

---

## 11. Extending

**Adding a bracket family.** `RATING_FAMILIES` in `blizzard.constants.ts` drives collection
names, the sweep's mirroring, the sync endpoint's fan-out, and the representation job. Add
the family and the collection appears with its indexes on next boot. `specSplitFamilyOf`
decides whether a family is spec-split (spec from the bracket name) or core (spec from the
profile).

**Adding a scheduled job.** Follow `SeasonScheduler`: `SchedulerRegistry.addInterval` in
`onApplicationBootstrap`, delete it in `onModuleDestroy`, guard re-entry with a `running`
flag, and decide where it sits in the priority order (§4). Anything below live ingestion
should check `coordinator.isLiveIngestionActive`, and anything genuinely low priority should
wait on `warmedUp$`.

**Adding a profile field.** Extend `characterProfileSchema`, `CharacterProfile`, the
appropriate key list (`PROFILE_SUMMARY_KEYS` or `PROFILE_SPEC_KEYS` — they are
`satisfies keyof CharacterProfile`, so a typo fails to compile), the repository's `$set`,
and the sync DTO. Existing characters need `profileFetchedAt`/`specsFetchedAt` cleared to
pick the field up before the TTL expires.

**Adding an index.** `characters` is near no cap, but remember the 64-index limit and prefer
extending the wildcard-covered maps over adding per-key indexes.

---

## 12. Known limitations

- **No authentication** on `POST /characters/sync` or on the health endpoints. The
  `/admin/*` triggers are unauthenticated too, which is why they 404 outside development.
- **Repositories and aggregation pipelines have no automated coverage.** An integration
  suite against a throwaway Mongo would be the highest-value addition.
- **Completeness for pre-`archive_brackets` seasons is still inferred from rows**, so one of
  those with an empty ladder stays unadoptable if its marker is lost. Re-archiving the season
  once populates the record and closes it.
- **A season Blizzard stops serving is marked `unarchivable`** and skipped forever. That is
  right for seasons below 22, but a prolonged 404 on a season that _should_ exist would be
  recorded the same way; clear the marker by hand to retry it.
- **The sync endpoint's 409 is a check, not a lock** (§7).
- **Full archive backfill is ~19.7M rows / ~5.2GB.** Driven by breadth (83 brackets × 20
  seasons × 4 regions), not depth — `ARCHIVE_MAX_ENTRIES_PER_BRACKET` saves only ~1%;
  `ARCHIVE_MIN_SEASON` is the real lever. Seasons below 22 return 404.
- **Enrichment backlog.** At default batch size a full pass over ~138k characters takes
  roughly two days, and the archive yields to enrichment, so a backfill running alongside it
  progresses only in the gaps.
- **The season purge is irreversible and fires at boot on a first deploy** (§4.6). Ship
  behind `SEASON_PURGE_DRY_RUN=true` and read the logged plan before flipping it.
- **Cross-region boards need four queries merged**, or a `seasonId + rating` index; the
  current index is prefixed by region.
