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

404 → `profileStatus: 'missing'`, both timestamps stamped, not retried.

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
`ARCHIVE_MIN_SEASON` / `ARCHIVE_MAX_SEASON`) and returns the first without a completion
marker. Before returning one it samples the data itself — three random brackets, up to ten
rows each — and if rows exist it writes back the marker and skips. That covers a crash
mid-season or a dropped `archive_seasons` collection.

The scheduler takes one season per pass and comes straight back while work remains,
pausing `ARCHIVE_SEASON_PAUSE_MS` between seasons.

### 4.5 Season refresh

`SeasonScheduler` re-reads the active season daily, independently of sweeps, so a rollover
is caught even when ingestion is disabled or failing. Logs two distinct warn-level
transitions: a season **ending** and a **rollover**.

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
  profileStatus: 'ok' | 'missing',
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

### 5.4 Archive — `archive_entries` + `archive_seasons`

```js
// archive_entries
{ seasonId, region, bracket, characterId, characterName, realmId, realmSlug,
  faction, rank, rating, played, won, lost }

// archive_seasons  (the run-once marker)
{ seasonId, region, name, startsAt, endsAt, brackets, entries,
  failedBrackets: [], archivedAt }
```

Archive rows are **self-contained** — no reference into `characters`. Historical standings
must keep reading correctly forever, and a character can be renamed, transferred or deleted
long after the season it played in. No profile enrichment: it costs two requests per
character and would describe the player _today_, not during that season.

Indexes: `archive_board`, `archive_identity` (unique), `archive_character`.

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

### `GET /health`

```json
{
  "status": "ok",
  "uptimeSeconds": 20,
  "sweepRunning": false,
  "seasons": { "us": { "id": 42, "name": "…", "startsAt": "…", "endsAt": null } }
}
```

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

| Variable                             | Default                        | Notes                                       |
| ------------------------------------ | ------------------------------ | ------------------------------------------- |
| `BLIZZARD_CLIENT_ID` / `_SECRET`     | —                              | **Required**                                |
| `BLIZZARD_REGION`                    | `us`                           | OAuth host region only (`us,eu,kr,tw,cn`)   |
| `BLIZZARD_REGIONS`                   | `us,eu,kr,tw`                  | Ladders to ingest — distinct from the above |
| `BLIZZARD_LOCALE`                    | `en_US`                        |                                             |
| `BLIZZARD_REQUEST_TIMEOUT_MS`        | `30000`                        |                                             |
| `BLIZZARD_RETRY_LIMIT`               | `3`                            |                                             |
| `BLIZZARD_CONCURRENCY`               | `8`                            | Parallel bracket fetches per sweep          |
| `MONGODB_URI`                        | —                              | **Required**                                |
| `MONGODB_DB`                         | `rankwarden`                   |                                             |
| `INGEST_INTERVAL_MS`                 | `3600000`                      |                                             |
| `INGEST_RUN_ON_STARTUP`              | `true`                         |                                             |
| `PROFILE_ENRICHMENT_ENABLED`         | `true`                         | `false` releases the archive warm-up gate   |
| `PROFILE_INTERVAL_MS`                | `300000`                       |                                             |
| `PROFILE_BATCH_SIZE`                 | `500`                          | Characters per pass                         |
| `PROFILE_SUMMARY_TTL_MS`             | `604800000`                    | 7 days                                      |
| `PROFILE_SPECS_TTL_MS`               | `86400000`                     | 1 day                                       |
| `PROFILE_CONCURRENCY`                | `8`                            |                                             |
| `PROFILE_REQUESTS_PER_SECOND`        | `20`                           | Token bucket                                |
| `SEASON_REFRESH_INTERVAL_MS`         | `86400000`                     |                                             |
| `REPRESENTATION_ENABLED`             | `true`                         |                                             |
| `REPRESENTATION_CHECK_INTERVAL_MS`   | `3600000`                      |                                             |
| `REPRESENTATION_MIN_RATINGS`         | `1500,1800,2100,2300,2700`     | Cutoffs to track                            |
| `ARCHIVE_ENABLED`                    | `true`                         |                                             |
| `ARCHIVE_CHECK_INTERVAL_MS`          | `3600000`                      |                                             |
| `ARCHIVE_SEASON_PAUSE_MS`            | `5000`                         | Breather between seasons                    |
| `ARCHIVE_CONCURRENCY`                | `4`                            |                                             |
| `ARCHIVE_REQUESTS_PER_SECOND`        | `10`                           |                                             |
| `ARCHIVE_MIN_SEASON` / `_MAX_SEASON` | `0` / `0`                      | 0 = unbounded; the real size lever          |
| `ARCHIVE_MAX_ENTRIES_PER_BRACKET`    | `5000`                         | Top N by rating; saves only ~1%             |
| `NODE_ENV` / `PORT` / `LOG_LEVEL`    | `development` / `3000` / `log` |                                             |

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

### 9.8 Cleanup has three distinct paths

| Cleanup                                      | Removes                       | Case                       |
| -------------------------------------------- | ----------------------------- | -------------------------- |
| `pruneBracket` (per bracket, by `fetchedAt`) | rows not refreshed            | character left that ladder |
| `removeOrphans` (vs `characters`)            | rows whose character is gone  | character deleted          |
| `removeRetiredBrackets`                      | rows for unpublished brackets | a spec ladder disappears   |

`removeRetiredBrackets` refuses to act when a region produced no brackets — that means the
sweep failed, not that every ladder retired; without the guard a failed region is wiped.

---

## 10. Testing

`npm test` — 86 tests across 13 files, no database or network required. Vitest runs through
SWC so Nest DI works in tests.

Patterns in use:

- **Pure functions** tested directly: `mapWithConcurrency`, `RateLimiter`, `toSlug`,
  `startOfUtcDay`, `activeLoadoutsBySpec`, `ratingFamilyOf`, `isIngestableBracket`.
- **Services** via `Test.createTestingModule` with repositories and API clients replaced by
  `vi.fn()`. See `profile-enrichment.service.spec.ts` and `archive.service.spec.ts`.
- **`ConfigService`** stubbed as `{ get: (key) => env[key] }` over a plain object.
- **`IngestionCoordinator`** used real, not mocked — it is pure state and its interaction
  with the services under test is the thing worth asserting.

What is **not** covered by unit tests: every repository (they are thin wrappers over driver
calls) and the aggregation pipelines. Those were verified against the live database with
throwaway probe scripts. When changing a pipeline, verify against real data — a pipeline
that returns plausible numbers can still be wrong, as §9.2 shows.

A useful pattern for that: write the pipeline with extra per-document detail retained, run
it against Mongo, and compare old versus new attribution side by side.

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

- **No authentication** on `POST /characters/sync`.
- **Repositories and aggregation pipelines have no automated coverage.** An integration
  suite against a throwaway Mongo would be the highest-value addition.
- **The archive completeness check is a sample**, drawn from brackets that are present, so it
  cannot distinguish a complete season from one that crashed part-way. `failedBrackets` is
  the authoritative record for seasons archived normally.
- **The sync endpoint's 409 is a check, not a lock** (§7).
- **Full archive backfill is ~19.7M rows / ~5.2GB.** Driven by breadth (83 brackets × 20
  seasons × 4 regions), not depth — `ARCHIVE_MAX_ENTRIES_PER_BRACKET` saves only ~1%;
  `ARCHIVE_MIN_SEASON` is the real lever. Seasons below 22 return 404.
- **Enrichment backlog.** At default batch size a full pass over ~138k characters takes
  roughly two days, and the archive yields to enrichment, so a backfill running alongside it
  progresses only in the gaps.
- **Old-season documents are not purged from the live collections** after a rollover. The
  archive makes them redundant but nothing deletes them yet.
- **Cross-region boards need four queries merged**, or a `seasonId + rating` index; the
  current index is prefixed by region.
