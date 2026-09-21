# Rankwarden — capabilities reference

Ingestion service for World of Warcraft competitive data. It pulls PvP leaderboards and
character detail from the Blizzard Game Data API and top Mythic+ runs from the Raider.io
API, keeps them in MongoDB in shapes tuned for the queries a front end actually makes, and
maintains a daily record of specialisation representation plus an archive of finished
seasons.

The two upstreams are metered, budgeted and health-checked **independently**. Nothing
Raider.io costs is ever charged against Blizzard's quota, and vice versa.

This document is written for agents that need to test or extend the service. It covers
what exists, why it is shaped that way, and the domain traps that are easy to
reintroduce. Read [Domain rules](#domain-rules-and-traps) before changing ingestion or
aggregation logic — several of those rules were found by observing wrong data, not by
reading the API docs.

---

## 1. Stack and hard constraints

|             |                                                                                        |
| ----------- | -------------------------------------------------------------------------------------- |
| Runtime     | Node ≥ 22 (developed on 26), **ESM** (`"type": "module"`)                              |
| Framework   | NestJS 12                                                                              |
| HTTP client | got 16 (ESM-only — this is why the project is ESM)                                     |
| Validation  | zod 4                                                                                  |
| Database    | MongoDB 8 via the official `mongodb` driver 7 (no ODM)                                 |
| Tests       | Vitest 4, transformed through SWC so `emitDecoratorMetadata` works                     |
| Auth        | `@denipetrov/blizz-auth` (private, GitHub Packages); Raider.io uses a query-string key |

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
    quota/rolling-window.ts            the counter both budgets are built on
    quota/quota-budget.service.ts      Blizzard's hourly budget + priority shares
    quota/raiderio-budget.service.ts   Raider.io's per-minute budget
    utils/concurrency.ts               bounded parallel map
    utils/rate-limiter.ts              token bucket
  blizzard/
    blizzard.constants.ts       regions, brackets, families, exclusions
    auth/                       token provider seam + blizz-auth adapter
    http/                       shared got instance, typed BlizzardApiError
    schemas/                    zod schemas for every payload consumed
    pvp.api.ts                  season index/detail, bracket index, leaderboards
    profile.api.ts              character summary + specializations
  raiderio/
    raiderio.constants.ts       regions (cn included), page cap, first M+ expansion
    http/                       shared got instance, key injection, typed errors
    schemas/                    zod schemas for every Raider.io payload consumed
    mythic-plus.api.ts          runs pages + season static data
  mplus-season/
    mplus-catalogue.service.ts  every main season + dungeon, walked across expansions
    mplus-catalogue.mapper.ts   catalogue mapping; which season is current per region
    mplus-catalogue.repository.ts  mplus_seasons + mplus_dungeons (+ archive markers)
    mplus-season.service.ts     current season per region, observed + announced
    mplus-season.scheduler.ts   catalogue at boot, season check hourly
    mplus-season-events.service.ts   rxjs Subject for "ended" / "rollover"
    mplus-season-state.repository.ts mplus_season_state + mplus_season_transitions
    mplus-season-transition.service.ts   retires a superseded season per region
    mplus-season-transition.scheduler.ts interval + on every rollover
  mplus/
    mplus.mapper.ts             payload -> documents; the per-character score fold
    mplus.repository.ts         mplus_runs + mplus_characters + mplus_affixes
    mplus.service.ts            the pass
    mplus.scheduler.ts          interval + warm-up gate
  mplus-archive/
    mplus-archive.mapper.ts     which seasons are still owed
    mplus-archive.repository.ts mplus_archive_runs + mplus_archive_characters
    mplus-archive.service.ts    archives each finished season once
    mplus-archive.scheduler.ts  interval + two warm-up gates
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

Six jobs run on intervals. They compete for an upstream quota, for MongoDB, and in part
for the same documents, so [`IngestionCoordinator`](src/common/ingestion-coordinator.service.ts)
ranks them:

| Priority | Job                     | Cadence                                                          | Yields to                    | Upstream  |
| -------- | ----------------------- | ---------------------------------------------------------------- | ---------------------------- | --------- |
| 1        | **Leaderboard sweep**   | `INGEST_INTERVAL_MS` (1h)                                        | nothing                      | Blizzard  |
| 2        | **Profile enrichment**  | `PROFILE_INTERVAL_MS` (5m) + after each sweep                    | the sweep                    | Blizzard  |
| 3        | **Mythic+ pass**        | `MPLUS_INTERVAL_MS` (6h), after warm-up                          | sweep **and** enrichment     | Raider.io |
| 3        | **Spec representation** | `REPRESENTATION_CHECK_INTERVAL_MS` (1h), writes once per UTC day | the sweep                    | none      |
| 4        | **Season archive**      | `ARCHIVE_CHECK_INTERVAL_MS` (1h)                                 | sweep, enrichment **and** M+ | Blizzard  |
| 5        | **Mythic+ archive**     | `MPLUS_ARCHIVE_CHECK_INTERVAL_MS` (1h), after both warm-ups      | **every** job above          | Raider.io |
| —        | **Season refresh**      | `SEASON_REFRESH_INTERVAL_MS` (1d)                                | nothing (2 requests)         | Blizzard  |
| —        | **Season transition**   | `SEASON_TRANSITION_CHECK_INTERVAL_MS` (1h) + on every rollover   | nothing (no API calls)       | none      |
| —        | **M+ season check**     | `MPLUS_SEASON_CHECK_INTERVAL_MS` (1h) + at boot                  | nothing (catalogue only)     | Raider.io |
| —        | **M+ season transition** | `MPLUS_TRANSITION_CHECK_INTERVAL_MS` (1h) + on every rollover   | a running M+ pass (waits)    | none      |

The coordinator exposes `isSweepActive`, `isEnrichmentActive`, `isMplusActive`,
`isArchiveActive`, `isMplusArchiveActive`, `isLiveIngestionActive`,
`isAboveMplusArchiveActive`, `isWarmedUp`, `isMplusWarmedUp`, `warmedUp$` and
`mplusWarmedUp$`. `duringSweep()` / `duringEnrichment()` / `duringMplus()` /
`duringArchive()` / `duringMplusArchive()` wrap the work.

> **Why the PvP archive now registers itself.** Nothing above it waits on it, so it never
> needed to. It does now purely so the Mythic+ archive — the one job below it — can yield
> to it. Without that, the two lowest-priority jobs would share every gap the live jobs
> leave, which is exactly what "lowest priority" rules out.

> **Why M+ yields at all.** The two upstreams meter separately, so no _request_ of the M+
> pass competes with a Blizzard job — it yields because it shares MongoDB and the process,
> and a minutes-long pass writing hundreds of thousands of documents alongside a sweep
> would slow the boards that serve live traffic. `isMplusActive` is deliberately **not**
> folded into `isLiveIngestionActive`: the archive must wait for M+, but enrichment must
> not. Enrichment spends Blizzard quota and M+ spends none, so making enrichment yield
> would cost the PvP profiles freshness to protect a job it is not competing with.

**Warm-up gate.** The archive does not tick at bootstrap. It subscribes to `warmedUp$`,
which fires once the first sweep _and_ first enrichment pass have both completed.
`markEnrichmentDisabled()` releases the gate when enrichment is switched off — without it
the archive would wait forever for a pass that never comes.

**The Mythic+ archive has a second gate**, `mplusWarmedUp$`, which fires when the first live
Mythic+ pass finishes — or at boot, from `markMplusDisabled()`, when Mythic+ is off. It is
separate from `warmedUp$` so the PvP archive never starts waiting on a Mythic+ job it has
nothing to do with. The scheduler subscribes to **both** and re-checks both conditions at
every tick, because they arrive in either order.

> **A gate that the boot order hides.** At a real boot the live pass subscribes to
> `warmedUp$` before the archive does, so it is already active when the archive checks —
> which protects the archive even with the second gate removed. The integration test passed
> with the gate deleted. The gates are therefore pinned by a unit spec
> (`mplus-archive.scheduler.spec.ts`) where nothing else can stand in for them.

### 4.0 The shared Blizzard quota budget

The coordinator decides who runs _now_. [`QuotaBudget`](src/common/quota/quota-budget.service.ts)
decides how much each may spend _this hour_. They are separate because they fail
separately: a job can be allowed to run and still have nothing left to spend.

Blizzard enforces **36,000 requests an hour** across the whole client. Before the budget,
each job carried a private rate limiter sized as if it owned that quota — the archive
alone was allowed 10/s, which _is_ the whole hourly cap — and nothing added them up. During
a backfill the archive runs in every gap between enrichment passes, so archive, enrichment
and sweep together came to roughly 41,000 an hour.

Every real request is charged, **retries included**, by the HTTP client's `beforeRequest`
hook, which fires once per attempt. It is attributed to the job in progress through the
run context (`withRunId`), so a season refresh inside a sweep is the sweep's without any
call site saying so. The window is a rolling hour of one-minute buckets, errring towards
over-counting.

Shares, in priority order:

| Job        | Share                                                         | Throttled?                  |
| ---------- | ------------------------------------------------------------- | --------------------------- |
| Sweep      | `QUOTA_SWEEP_RESERVE` (1,000) held back until it spends it    | **never**                   |
| Enrichment | `QUOTA_HOURLY_LIMIT / QUOTA_ENRICHMENT_HEADROOM` (12,000)     | yes — batch shrinks to fit  |
| Archive    | what is left after the reserve and enrichment's unspent share | yes — pauses until it rolls |
| Other      | season refreshes, snapshots, admin calls                      | never, but counted          |

Only `usable` = `QUOTA_HOURLY_LIMIT × QUOTA_UTILISATION` (32,400) is ever planned against.
The margin absorbs requests already in flight when a check is made, and retries on batches
sized before they failed — neither of which a budget can see coming. A boot-time check
refuses shares that promise more than is usable.

At the defaults: sweep ~340/h, enrichment up to 12,000/h, archive up to 19,400/h — a total
that fits, where the old per-job limiters did not.

> **Known gap.** The budget lives in memory, so a restart forgets the last hour. Persisting
> every request would cost more than the overrun it guards against; Blizzard's own 429s,
> which the client retries, are the backstop.

### 4.0.1 The Raider.io budget

[`RaiderIoBudget`](src/common/quota/raiderio-budget.service.ts) is a **separate budget for
a separate upstream**, and the separation is load-bearing rather than tidy. `QuotaBudget`
models Blizzard's 36,000-an-hour cap and divides it between the sweep, enrichment and the
archive; charging foreign requests to it would throttle all three for no reason and make
`/health/ready` misreport every one of them.

|                 | Blizzard (`QuotaBudget`)             | Raider.io (`RaiderIoBudget`)           |
| --------------- | ------------------------------------ | -------------------------------------- |
| Window          | rolling hour, one-minute buckets     | rolling **minute**, one-second buckets |
| Ceiling         | `QUOTA_HOURLY_LIMIT` (36,000)        | `RAIDERIO_MINUTE_LIMIT` (1,000)        |
| Planned against | `x QUOTA_UTILISATION` (32,400)       | `x RAIDERIO_UTILISATION` (900)         |
| Consumers       | sweep / enrichment / archive / other | mplus / other                          |
| Shares          | three, in priority order             | one flat allowance                     |

**What they share is [`RollingWindow`](src/common/quota/rolling-window.ts), not the policy
on top of it.** That was the choice the brief asked to be justified: the counter is the
only fiddly part — a bucket ring that forgets old events without holding a timestamp per
event — and the policies have nothing in common, so a provider-keyed budget with two sets
of share logic inside it would have been one class doing two unrelated jobs. `QuotaBudget`
was refactored onto the shared window in the same change, so both are exercised by the
existing budget tests.

The bucket size differs on purpose. Raider.io enforces a **minute**, so a minute-resolution
window would be a single bucket: the budget would read zero for 59 seconds and then the
whole minute's spend at once.

Properties it keeps from the Blizzard one: charged **per attempt including retries**, at
the HTTP client's `beforeRequest` hook rather than at call sites, attributed through
`withRunId('mplus', …)` so no call site passes a label, readable from memory for readiness,
and sanity-checked at boot (`superRefine` refuses a token bucket that exceeds the per-minute
allowance, and an M+ interval too short for a full pass at the permitted rate).

**The numbers, and where they came from.** Raider.io's documentation states **200
requests/minute unauthenticated**, lifted for applications registered at
`raider.io/settings/apps`. A measured 300-request burst at concurrency 20 on the configured
key drew **zero 429s** (2026-09-14), and **no `X-RateLimit-*` header is exposed on a
success** — so the ceiling is configuration, not something readable back from a response.
`RAIDERIO_MINUTE_LIMIT` defaults to the 1,000/minute the key is provisioned for; lower it
if 429s appear. `Retry-After` _is_ honoured, by got's own delay calculation, capped by
`maxRetryAfter` so a long header cannot park a request past the request timeout.

> **Same known gap.** In memory, per process; a restart forgets the last minute. A minute
> is short enough that this matters even less than it does for the hour.

**The archive's share.** The live pass and the Mythic+ archive spend from one per-minute
window, so the budget has a second consumer, `mplusArchive`, capped at
`RAIDERIO_ARCHIVE_SHARE` (half) of the usable minute. The live pass may use the whole
window; `allowanceFor('mplusArchive')` is the lesser of the room left and the archive's
unspent share.

The cap protects the live pass, and the reason is specific. The archive runs in exactly the
gaps _before_ a live pass begins, so without a cap it could fill the minute seconds before a
pass started — and the live pass used to **stop** the moment its allowance read zero,
skipping its prune and reporting degraded for a whole six-hour interval. Capped, a live pass
always starts with at least `usable - archiveShare`.

**Jobs now wait for a spent minute instead of giving up — a behaviour change to the live
pass.** A per-minute ceiling is a rate: the window frees itself within sixty seconds.
`waitForAllowance(consumer, needed, maxWaitMs, abandon)` polls until there is room, up to
`RAIDERIO_BUDGET_WAIT_MS` (one window). The live pass stops only when the window stays spent
for longer than that, which means something is genuinely over-spending. The archive passes an
`abandon` that is true whenever a higher-priority job is running, so it lets go of the wait
the moment the minute is most needed elsewhere. The test harness sets the wait to 0, so a
spent budget is still observable without a sixty-second sleep.

### 4.6 Mythic+ ingestion

`MplusService.sweep()` — the top Mythic+ runs of the current season, per region.

1. Make sure the season catalogue is loaded (`ensureCatalogue`) — **before any runs
   request**. Usually already fresh from the boot-time season check; otherwise read now.
2. Resolve and observe the season current in **each region** (§4.6.2). A region no
   catalogued season has opened in is skipped; on the day a season rolls, regions ingest
   different seasons side by side.
3. Per region, page through `mythic-plus/runs?dungeon=all` in batches of
   `RAIDERIO_PAGE_BATCH`, at `RAIDERIO_CONCURRENCY` in flight.
4. Write each batch's runs and affixes as it arrives; fold characters across the whole
   region; write the characters at the end.
5. Clean up in two stages — **only if the pass finished cleanly**: runs this pass did not
   refresh, then characters no surviving run lists (§5.6).
6. Nothing else. A superseded season is **not** deleted by the pass; the M+ season
   transition retires it once the archive holds it (§4.6.2).

Observed live (2026-09-14): 6 pages across us+eu in 987ms; a full pass is **1,001 requests
per region** — `page` 0–1000 inclusive, 20 runs a page, 20,020 runs. At five regions that
is **5,005 requests and ~100,000 runs per pass**, roughly 20,000 requests a day at the
6-hour default.

**Two things are streamed and one is not.** Runs are written per batch, because a region is
~100,000 roster rows and holding all of them before the first write would make memory scale
with the ladder. The character fold cannot be: `mythicScore` is a character's best run in
each dungeon summed across the _whole_ region, so it is only correct once the last page is
read. The fold keeps ~8 entries per distinct character, so its working set is bounded by
characters rather than by rows.

**The prune guard is the dangerous part.** A pass that stopped early — spent budget, a
yielded coordinator, failed pages — looks exactly like a leaderboard that lost most of its
runs. Pruning on that basis deletes the region and refills it next pass, with a hole in the
board each time. Same reasoning as `removeRetiredBrackets` refusing an empty bracket list
(§9.8). There are two guards, not one: the service skips the whole cleanup after a
shortfall, and `removeCharactersWithoutRuns` independently refuses to act on a region with
no runs at all, so a future caller that forgets the first still cannot empty a region.

The per-region result carries **`mergedCharacters`** — how many characters kept a stored
dungeon the freshly computed set no longer had (§5.6). It is worth watching rather than
ignoring: a number that climbs pass after pass says the ingested window is falling behind
the ladder, and the fix is `RAIDERIO_MAX_PAGES`, not more merging.

Where the data ends is signalled two ways, and both are handled: a region with fewer runs
than the page ceiling answers `200` with `rankings: []`, and `page` above 1000 answers
`400 {"message":"\"page\" must be less than or equal to 1000"}` — the documented end of
the data, not a failure, so `400` is deliberately absent from the retryable statuses.

### 4.6.1 Mythic+ archive

`MplusArchiveService.archiveBacklog()` — finished Mythic+ seasons, each archived once.

1. Refresh the season and dungeon catalogue if it is empty or past `MPLUS_CATALOGUE_TTL_MS`
   (§5.8).
2. Pick the newest season still owed: finished in **every** region, not `unarchivable`, and
   with at least one configured region (`RAIDERIO_REGIONS`) not `complete` (`regionsOwed`).
   Every catalogued season is a main season, so there is nothing else to filter.
3. For each region owed: if the season has no marker and the region's rows prove a full read,
   adopt them; otherwise read **that region's own board** — the same query as the live pass —
   pages `0..MPLUS_ARCHIVE_PAGES-1` (100 by default: 2,000 runs), writing runs per batch and
   folding characters across the region.
4. Write the marker **after** the rows, then take the next season.

**Per region, not `world`.** Until 2026-09-21 the archive read the `world` board. It is gone,
for two reasons. The world top 2,000 is dominated by one region — 1,212 of `season-tww-3`'s
were `cn`, 45 `tw` — so it held only the very top of the other boards. And a region's ranks,
scores and title cutoffs are read against that region's board, which the world board cannot
give. Each region now contributes its own top 2,000: **~500 requests and up to 10,000 runs a
season** at five regions, against 100 and 2,000 before.

A region with no board for a season answers **`200` with no rankings**, not an error —
Legion and BfA have none in `cn` — so it is `complete` with 0 runs. `404` still names the
whole season as unarchivable.

Observed live (2026-09-16), at the defaults, when the archive still read the `world` board: 6 expansions and 56 seasons listed, of which the
21 main seasons and their 74 dungeons are catalogued; **all 20 finished main seasons archived** — 39,997 runs, 31,837 characters, in
280s for the whole backlog, paced by the archive's share of the minute. 103MB of data,
25.6MB on disk plus 12MB of indexes. A second tick made no requests at all.

**"Once" is a marker, never a row count** — and it is kept **per region**, in
`archive.regions`. A board shorter than the page limit and a fetch that died halfway both
store fewer rows; only the marker tells them apart. A region whose marker was lost (the
collection dropped, say) is **adopted** from its rows only when they are exactly a full
read's worth; anything else is refetched, since adopting ambiguous rows would make a partial
region permanent, and the refetch costs 100 requests. One season can mix both: in the test,
the US is adopted and Europe, with a shallower board, is read again.

| Outcome for a region                      | Recorded                                 | Retried                  |
| ----------------------------------------- | ---------------------------------------- | ------------------------ |
| every page read, or the board ended first | region `complete`                        | never                    |
| a page failed (5xx, timeout, schema)      | region `incomplete`, season `incomplete` | that region, **in full** |
| 404 for the season                        | season `unarchivable`                    | never                    |
| a higher-priority job started mid-region  | regions already read kept; season `partial` | the rest, next tick   |

The season's `status` is judged over the configured regions: `complete` when every one is.
Only the regions owed are read on a retry, so one flaky region costs 100 requests, not 500.
A region is retried **in full**, not page by page, because its character fold needs every page
in one pass. Within one tick an `incomplete` season is set aside after failing, so it is retried
once a tick rather than in a loop until the share is spent — the trap `failedThisTick` exists
for in the PvP archive.

A **yield records no failure**. The region interrupted is read again from its first page;
regions finished before it are kept under a `partial` marker, so a long season is not restarted
from scratch every time the live jobs pre-empt it. A yield before any region finished writes
nothing at all.

**Archives from the `world` board are re-read.** A marker with no `regions` came from the old
reader and says nothing about any one region, so the season is owed again and read region by
region. Its rows are overwritten in place rather than deleted first: every run in the world
top 2,000 has a region rank at most its world rank, so it is inside its region's top 2,000
too, and every character on those runs is folded again. A region added to `RAIDERIO_REGIONS`
later is owed the same way, and read without refetching the others.

**No monotonic merge.** Archived characters are written with a plain `$set`: a finished
season cannot gain a run, and each document comes from one complete read.

### 4.6.2 Mythic+ seasons and transitions

The Mythic+ counterpart of §4.7 and §4.8, following the same rules. There is **no season
setting**: `RAIDERIO_SEASON` and `CURRENT_EXPANSION_ID` are gone, and the season comes from
the catalogue (`mplus_seasons`, §5.8), which already holds every main season with per-region
start and end dates.

**Which season is current** — `currentSeasonIn(seasons, region, now)`: the catalogued season
that most recently **opened in that region**. Decided on start dates only — never list order,
never end dates, since a running season carries Raider.io's `2030-01-01` placeholder end. A
region the season lists no start for takes its earliest start; a season with no start at all
is never current. Every catalogued season is a main season, so a side event cannot be picked.

**Catalogue before runs.** `MplusSeasonScheduler` ticks at boot: `ensureCatalogue()` (read
Raider.io if empty or past `MPLUS_CATALOGUE_TTL_MS`) then `observe()`. The live pass does the
same two things before its first page, so the ordering does not depend on the boot tick
winning a race. A refresh in flight is shared between callers. With the catalogue still empty
afterwards, the pass throws rather than guess. The check is idle unless `MPLUS_ENABLED` or
`MPLUS_ARCHIVE_ENABLED` is on — without one there is no key to read the catalogue with.

**Observing** — `MplusSeasonService.observe()` compares each region with what was last seen,
persisted in `mplus_season_state` and rehydrated in `onModuleInit`, so a rollover while the
process was down is still a rollover (`acrossRestart: true`). It publishes on
`MplusSeasonEvents.transitions$`:

| Event      | When                                                   | Reacts           |
| ---------- | ------------------------------------------------------ | ---------------- |
| `ended`    | same season, its end in the region has just passed     | logs only        |
| `rollover` | a different season is now current in the region        | transition tick  |

A season replaced before an `ended` observation was made emits only `rollover`, as on the
PvP side.

**A season's life, per region:**

1. **Running.** Ingested by the pass.
2. **Ended, successor not open.** Still current; the pass keeps ingesting it with no churn
   (the board does not empty between seasons). Archivable only once it has ended in **every**
   region (`isFinished`, §4.6.1).
3. **Successor open in the region.** The pass moves the region onto the new season. The old
   season's rows stay.
4. **Old season archived** (`complete`, or `unarchivable`). `MplusSeasonTransitionService`
   deletes the old season **in that region only** — characters first, then runs, so I18 holds
   at every moment — and records it in `mplus_season_transitions`.

`plan()` is read-only and on `GET /health/seasons`. It abstains with an empty catalogue
(every stored season would look like a leftover) and while a pass is running (it may still
be writing the old season). Candidates are stored seasons in the region that are not current
and opened before the current one; a slug the catalogue does not list is a leftover and is a
candidate too. There is **no once-only guard**: candidates come from stored rows, so a
retired pair only returns if rows did, and retiring it again is right.

**The rollover tick waits for the pass.** A rollover is most often noticed by the pass
itself, before its first page — so the tick it triggers would find that pass running and
abstain until the next hourly check. `whenMplusIdle()` on the coordinator lets it wait
instead and run the moment the pass finishes.

- `MPLUS_PURGE_REQUIRE_ARCHIVE` (default on) holds back a season the archive does not
  hold. Because the archive waits for the **last** region to end, the first region to roll
  keeps its old board for hours longer. Harmless: every read is scoped by season. With the
  archive switched off nothing is ever retired, which the scheduler warns about at boot.
- `MPLUS_PURGE_DRY_RUN` defaults to **off**, unlike `SEASON_PURGE_DRY_RUN`. The PvP default
  guards a first deploy deleting archived history at boot; here the pass used to delete a
  superseded season on the spot with no archive check, so there is no live history to
  protect, and an on default would leave every rolled season in place indefinitely.

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

**Only `characterType: 'PvP'` characters are enriched.** The ladder sweep knows little
beyond name, realm and rating, so a ladder character needs these two requests to get a
profile. An `M+` character arrives with its profile bundled into the one request that finds
it, so there is nothing left to fetch. Selection, the demand count, the population and the
stalest-refresh age all filter on the type through one `ENRICHABLE` constant in
`CharacterRepository`, so the outlook never counts demand no request will be made for.

Selection is `specsFetchedAt` ascending. Specs have the shorter TTL, so anything due for a
summary refresh is necessarily due for specs too — one timestamp paces the queue. The
field is absent until first enrichment, and absent sorts before any date, so newcomers win.

**The batch is computed every run**, not configured. It is the smallest of:

1. **the characters actually due** — counted with the same filter selection uses, so the
   two cannot disagree about which set they mean;
2. **what the request budget buys** at the average cost of those characters — one request
   when only specs are due, two when the summary is too. The same budget buys twice as many
   specs-only refreshes, which a fixed batch could not tell apart;
3. **`PROFILE_BATCH_SIZE`** (2,000) — now only a safety ceiling on run length and memory.

The request budget is the enrichment allowance from the shared quota, **paced** to this
run's even share of the hour (12,000 / 12 runs = 1,000) with a catch-up factor of 2, so a
run skipped for a sweep can be made up without one run draining the hour in a burst.

Each run also publishes an **outlook** — population, what is due, projected demand,
capacity, and what binds it — which readiness reports from memory (§7):

| Signal        | Means                                                          | Readiness |
| ------------- | -------------------------------------------------------------- | --------- |
| `infeasible`  | steady-state demand exceeds capacity; no budget keeps the TTLs | degraded  |
| `behind`      | the stalest spec refresh is older than twice its TTL           | degraded  |
| large backlog | many characters due, e.g. first fill                           | _healthy_ |

Demand is `population × (1h/specsTTL + 1h/summaryTTL)`: at 143,203 characters, ~6,800
requests an hour against a 12,000 share. **Past ~252,000 characters no budget formula keeps
the 1-day specs TTL** at a third of the quota — the lever then is the TTL, not the batch.

> **Why `PROFILE_BATCH_SIZE` moved from 500 to 2,000.** At 500 the batch, not the quota,
> was the binding limit: it capped the sustainable population at ~144,000 against 143,203
> in the database — a 0.6% margin, with nothing reporting it. The outlook names the binding
> constraint so a limit like that cannot hide again.
> A finished sweep also fires an immediate **new-characters-only** pass.

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

Permanence is decided by `error instanceof ZodError`. A schema failure is deterministic —
the same payload will not start parsing next time — so it waits out the full TTL; anything
else could be a blip and comes back sooner. The backoff is expressed by backdating the
timestamp rather than carrying another field and another index. Stored profile data survives
both: unlike a 404 the character still exists, and stale-but-real beats nothing.

That test is only sound because **an empty body never reaches it**. `got` resolves an empty
`200` to `''` rather than raising a parse error, so it would otherwise arrive as a `ZodError`
and be read as payload drift — parking every character a load-shedding gateway touched for
seven days, where a `502` from the same gateway would have returned within the backoff.
`BlizzardHttpService` rejects it as a `BlizzardEmptyResponseError` instead, at the one place
that still knows the response was a 200 with nothing in it (§6).

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
skipped permanently, so one dead season cannot block the backlog behind it. Any other
failure, and any season that comes back **incomplete** (a failed bracket), is skipped for
the rest of that tick only. The incomplete case matters because `nextPending` would hand the
same season straight back: before it was skipped, one bracket that kept failing was retried
every pause until the archive's share of the quota ran out.

**Season rewards** are a separate pass, `archivePendingRewards()`, run at the end of every
tick once the backlog is done, and from `POST /admin/archive-rewards`. It is **driven by
`archive_seasons` alone**. It asks only about seasons whose standings are archived in full:
`failedBrackets` empty, not `unarchivable`, in a configured region, with no rewards yet. A
season Blizzard will not serve (22–26 answer 403) never gets a marker, so it never costs a
rewards request. A season still missing brackets waits until they land. A season finished
in a tick gets its rewards in the same tick.

Each season costs one request, to `pvp-season/{id}/pvp-reward/index`. Rewards are placed
against the ladders the archive itself recorded (`archive_brackets` ∪ stored rows), so no
bracket list or season record is fetched for them. Add one `playable-specialization/{id}`
lookup the first time a spec is seen. A reward names
its spec only by id and bare name, and four names exist on two classes (Holy, Frost,
Protection, Restoration), so the class is what places a reward on its ladder. Class and spec
names, lowercased with spaces removed, give the bracket key (`Death Knight` + `Unholy` →
`shuffle-deathknight-unholy`; verified against all 40 live specs). The lookup is cached for
the life of the process, since a spec never changes class.

| Blizzard bracket type | Ladder                 | Split by       | Title (Midnight S1)                 |
| --------------------- | ---------------------- | -------------- | ----------------------------------- |
| `ARENA_3v3`           | `3v3`                  | —              | Galactic Gladiator                  |
| `BATTLEGROUNDS`       | `rbg`                  | faction        | Hero of the Alliance / of the Horde |
| `SHUFFLE`             | `shuffle-<class-spec>` | spec           | Galactic Legend                     |
| `BLITZ`               | `blitz-<class-spec>`   | spec + faction | Galactic Marshal / Warlord          |

2v2 awards no title. A live season carries 123 rewards (1 + 2 + 40 + 80). Faction cutoffs
normally match, but Shadowlands 3v3 had different ones for each side, so the faction is kept
wherever Blizzard splits a reward. A reward that cannot be placed (an unknown bracket type, a
spec Blizzard 404s, or a ladder the archive has no record of) is logged and left out rather
than guessed at.

| Rewards response                           | Recorded                                    | Asked again |
| ------------------------------------------ | ------------------------------------------- | ----------- |
| 200                                        | `rewards`, `rewardsFetchedAt`               | never       |
| **403 / 404**                              | `rewardsFailed: { statusCode, reason, at }` | **never**   |
| 5xx, timeout, empty body, spec lookup fail | nothing                                     | next pass   |

The pass reads its list once, so each season is asked at most once per pass whatever
happens. It yields to live ingestion and to a spent archive budget, leaving the rest pending.
Seasons archived before rewards existed have no `rewardsFetchedAt`, so the first pass fills
them in. A lost marker recovered from stored rows comes back without rewards and is picked up
the same way. To ask Blizzard again about a season recorded as failed, unset its
`rewardsFailed`.

### 4.7 Season refresh

`SeasonScheduler` re-reads the active season daily, independently of sweeps, so a rollover
is caught even when ingestion is disabled or failing. Logs two distinct warn-level
transitions: a season **ending** and a **rollover**, and publishes both on
`SeasonEvents.transitions$`.

State is **persisted** in `season_state` and rehydrated in `SeasonService.onModuleInit()`.
This is not a cache optimisation: without it `previous` is `undefined` on a fresh process,
so a rollover that happened while the service was down took the "first observation" branch
and was never recognised as a rollover at all. The transition purge hangs off that
comparison, so the persisted copy is what makes a rollover across a restart detectable.

### 4.8 Season transition (retiring a finished season)

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
  characterType: 'PvP',                          // 'PvP' | 'M+'; set on insert only
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
(`characterName+realmSlug`), `enrichment_specs_staleness` and `enrichment_profile_staleness`
(`characterType` then the timestamp), and **`bracket_ratings`** — a compound wildcard
`{ seasonId: 1, region: 1, 'ratings.$**': 1 }`.

**`characterType`** says where a character came from: `PvP` from the ladder sweep, `M+`
from the Mythic+ ingestion. It decides whether enrichment owes the character a profile
(§4.2). The sweep sets it with `$setOnInsert`, so a document another source created is never
reclassified into the enrichment queue. Documents from before the field existed are
backfilled to `PvP` at boot, in `onModuleInit` and so before any scheduler starts. The sweep
was the only writer then. The sync endpoint never touches the type.

> **In practice `characters` holds only `PvP` today.** M+ characters live in their own
> collection (§5.5) — three findings ruled out sharing this one, and they are worth knowing
> before anyone moves them back:
>
> 1. **Raider.io's character id is not Blizzard's.** Cross-checked against the Blizzard
>    profile API on 2026-09-14: exxibae-stormrage is `258653729` to Blizzard and
>    `228420218` to Raider.io; skollcat-area-52 `246128989` vs `237437412`;
>    noxiv-zuljin `265250912` vs `257799685`; shakyaa-illidan `233519897` vs `308211232`.
>    Both id spaces are nine-digit integers in the same range, so one written where the
>    other is expected collides **silently** under `character_identity`.
>    (`realm.wowRealmId` _is_ Blizzard's realm id — verified for stormrage 60, area-52
>    1566, zuljin 61, illidan 57.)
> 2. **About 1 roster entry in 200 is anonymised, and every one carries `id: 0`** with the
>    placeholder realm `anonymous`. The id is not unique even within Raider.io's own data.
> 3. **The seasons collide.** M+ season 2 of Midnight is Blizzard season **18** while the
>    live PvP season is **42**, and `SeasonTransitionService.purge()` deletes from
>    `characters` by `{ seasonId, region }` with **no type filter** (nor does
>    `RatingRepository.removeOrphans` when it builds its known-set). PvP season 18 is a
>    real historic season, so retiring it would have silently deleted M+ documents.
>
> The audit the brief asked for, for the record: `removeUnranked` matches `brackets: {}`,
> which an M+ document without a `brackets` field would not match — but one written with an
> empty map **would** be deleted on every sweep. `pruneBracket`, `removeRetiredBrackets` and
> the excluded-bracket purge are all keyed on bracket names an M+ document has none of, so
> they are genuine no-ops. The purge and `removeOrphans` are the two that are not.

Enrichment's `ENRICHABLE` filter and the two `characterType`-led staleness indexes are
therefore belt-and-braces rather than load-bearing today. **Keep them.** They are what makes
putting an `M+` document in this collection safe if that is ever wanted, and the index
prefix costs nothing.

> **Why the staleness indexes lead with the type.** A character that is never enriched
> never gets a timestamp, and an absent field sorts ahead of every date. Keyed on the
> timestamp alone, every M+ character would sit at the front of the index order, and each
> enrichment run would read all of them before reaching one it can use. The superseded
> `specs_staleness` / `profile_staleness` are dropped at boot, after their replacements exist.

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
  failedBrackets: [], archivedAt, unarchivable?, lastError?,
  rewards: [                                   // one per ladder, per faction where split
    { bracket: 'shuffle-warrior-fury', faction: null, ratingCutoff: 3184,
      title: 'Galactic Legend: Midnight Season 1', achievementId: 61179,
      specialization: { id: 72, name: 'Fury' } },
    { bracket: 'rbg', faction: 'HORDE', ratingCutoff: 2684,
      title: 'Hero of the Horde: Galactic', achievementId: 61196, specialization: null },
  ],
  rewardsFetchedAt,                            // set with rewards
  rewardsFailed? }                             // { statusCode, reason, at } on 403/404; never retried

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

A season's standings are **settled** when `failedBrackets` is empty or it is `unarchivable`.
Rewards are tracked apart from that and never hold the backlog up: a season awaits them
while it is settled, not `unarchivable`, and has neither `rewardsFetchedAt` nor
`rewardsFailed`. `rewards[].bracket` uses the same keys as `archive_entries`, and
`specialization.id` is Blizzard's spec id, the same one `characters.profile.spec` carries.

Indexes: `archive_board`, `archive_identity` (unique), `archive_character`, and
`bracket_identity` (unique) on `archive_brackets`.

### 5.5 Mythic+ — `mplus_runs` + `mplus_characters` + `mplus_affixes`

```js
// mplus_runs - one completed run from the Raider.io leaderboard
{ season: 'season-mn-2', region: 'us', keystoneRunId: 10211398,
  rank: 1, score: 502.6,
  dungeon: { id: 16368, name: 'Den of Nalorakk', slug: 'den-of-nalorakk', shortName: 'DON' },
  mythicLevel: 21, clearTimeMs: 1785294, keystoneTimeMs: 1920999,
  timeRemainingMs: 135705, numChests: 1, completedAt: Date,
  affixIds: [9, 10, 147],                      // names live once, in mplus_affixes
  faction: 'alliance',
  roster: [                                    // all five, anonymised members included
    { rioCharacterId: 228420218,               // Raider.io's id, NOT Blizzard's
      characterName: 'Exxibae', realmSlug: 'stormrage',
      realmId: 60,                             // wowRealmId; null when anonymised
      region: 'us', classId: 1, className: 'Warrior',
      specId: 71, specName: 'Arms', role: 'dps',
      faction: 'alliance', anonymized: false },
  ],
  rosterKeys: ['us/stormrage/exxibae', …],     // flat mirror, named members only
  fetchedAt: Date }

// mplus_characters - one per character per M+ season + region
{ season: 'season-mn-2', seasonId: 18,         // Blizzard's M+ id; reference only
  region: 'eu', realmSlug: 'nemesis', nameKey: 'lairasp',
  characterName: 'Lairasp', characterType: 'M+',
  rioCharacterId: 224292179, realmId: 1316, realmName: 'Nemesis', faction: 'alliance',
  profile: { classId, className, specId, specName, raceId, raceName, level, role },
  mythicScore: 3506.7,                         // see the warning below
  dungeonsCovered: 7,                          // of the season's 8
  dungeonRuns: [                               // best run per dungeon, best score first
    { dungeon: {…}, keystoneRunId, mythicLevel, score, clearTimeMs,
      timeRemainingMs, numChests, completedAt, specId, role },
  ],
  updatedAt: Date }

// mplus_affixes - learned from payloads, never hardcoded
{ id: 9, name: 'Tyrannical', slug: 'tyrannical', description: '…', icon, updatedAt }
```

Identity is **`season + key`**, where `key` is `region/realmSlug/lowercased-name` —
Blizzard's own notion of a character, needing no id from either upstream. One canonical
string rather than a four-field tuple, because the same key is what `mplus_runs.rosterKeys`
stores: the orphan cleanup becomes a set difference instead of a join, and the merge read
can `$in` on it. Invariant I17 asserts it never drifts from the fields beside it — a
drifted key is unreachable by lookup _and_ invisible to the cleanup, so it would survive
every pass forever.

> **`mythicScore` is bounded by what was ingested, not by what the character played.** It is
> the sum of `score` over the best run in each dungeon **among the runs on the ingested
> leaderboard**. The feed is the top ~20,020 runs per region across all dungeons, so a
> dungeon the character has no top-20k run in contributes nothing. Measured over the top
> 1,200 US runs: **392 of 1,096 characters appeared in exactly one dungeon and only 150 in
> all eight**. It is therefore _not_ Raider.io's own mythic+ score, and is only comparable
> between characters with the same `dungeonsCovered` — which is why that field is stored
> next to it and a front end must gate on it, the same way §9.6 gates on `classified`.
> `dungeon=all` at least spreads evenly across dungeons (90–240 of the top 1,200 US runs per
> dungeon), so the shortfall is depth, not bias. Per-dungeon querying would fix it at 8x the
> requests.

**Anonymised players are kept in `roster` and excluded from `mplus_characters`.** The run is
a fact and a five-person party listing four would be wrong; but they all share `id: 0` and
the realm `anonymous`, so a character document for one would be all of them folded together
under one player's name. `isAnonymised` checks three independent signals — the character
flag, the realm flag, and the `id: 0` / `anonymous` pair — so dropping any one upstream
degrades into nothing rather than into that fold.

**Runs are self-contained**, for the same reason `archive_entries` are (§5.4): a run is a
historical fact that must keep reading after the character is renamed, transferred, or
pruned off the board. `rosterKeys` is a flat mirror purely so one index answers "every run
this character is in" without scanning nested documents.

**Affixes are a collection, not a constant.** The pool changes between seasons and Blizzard
has reworded affixes mid-expansion, so names are learned from the payloads that carry them —
the same approach `season-rewards.ts` takes to specialisations (§7 "things that are not
improvements"). The saving is real: three affixes with a ~120-character description each,
across ~100,000 runs a pass, is about **36MB of duplicated prose** not written.

**Runs are upserted with a whole-document `$set`**, which makes no difference to their
content (a finished run is immutable) but does refresh `fetchedAt`, which is what the prune
distinguishes a still-ranked run by.

**Characters are read-merge-write**, because `mythicScore` must never fall — see §5.6.
Everything _except_ `dungeonRuns` is still overwritten wholesale: name, realm, faction and
profile are facts about the character now, and a rename or a respec should follow along
rather than be merged into the past.

Indexes — `mplus_runs`: `run_identity` (unique `season+region+keystoneRunId`), `run_board`
(`season+region+score` desc), `run_dungeon_board`, `run_roster` (`rosterKeys`),
`run_freshness` (drives stage 1 of the cleanup). `mplus_characters`:
`mplus_character_identity` (unique `season+key`, and what the merge read `$in`s on),
`mplus_score_board` (`season+region+mythicScore` desc — the front end's sort) and
`mplus_character_lookup`. There is deliberately **no** freshness index on characters: since
§5.7 stage 2 replaced the timestamp check with a referential one, nothing queries
`updatedAt`, and an index nothing reads only costs write throughput.

**Season rollover is retired per region, after the archive.** A superseded season is
not deleted by the pass. It stays until its successor has opened in the region **and** the
Mythic+ archive holds it, then `MplusSeasonTransitionService` removes it from that region —
the same gate as §4.8. See §4.6.2.

### 5.6 Why `mythicScore` only ever goes up

A real Mythic+ score cannot fall: it is your best run in each dungeon, ever. A score
recomputed from a **window** of the leaderboard can, because a run that sat inside the top
20,020 last pass can be pushed out of it by other people's newer runs while the player does
nothing at all. Recomputing blindly would render that as the player losing points, hourly.

So each dungeon keeps the better of its stored and its freshly computed run
(`mergeDungeonRuns`), and the score is re-derived from the result.

**Merging per dungeon rather than clamping the total is the part worth keeping.** Clamping
(`mythicScore = max(stored, computed)`) would leave the document describing a set of runs
that does not add up to the score printed on it, with `dungeonsCovered` counting a third
set again — invariant I12 could never hold, and nothing downstream could recompute or audit
the number. Merging per term makes the sum monotonic _because_ each term is, and the
document stays self-consistent. A tie keeps the stored run, so `dungeonRuns` does not churn
for a reader diffing one pass against the next.

Monotonic does not mean frozen: a better run for a dungeon replaces it immediately, and a
dungeon never seen before is simply added.

> **The consequence to know.** A dungeon's entry is kept once earned, so
> `dungeonRuns[].keystoneRunId` may point at a run that has since fallen off the board and
> been pruned from `mplus_runs`. That is deliberate — `mplus_runs` mirrors the _current_
> leaderboard, `dungeonRuns` remembers a best run — so **a reader must treat that join as
> optional.** An integration case asserts the dangling reference exists, so it cannot be
> "fixed" by accident; invariant I18 deliberately checks only the other direction.

The rule lives in one place and every write path goes through it: the pass, and
`POST /mplus/characters/sync` (§7). There is no payload and no pass that lowers a score.

### 5.7 Mythic+ cleanup — two stages, in this order

Run once per region at the end of every clean pass, mirroring §9.8 on the PvP side:

| #   | Stage                                              | Removes                           | Case                               |
| --- | -------------------------------------------------- | --------------------------------- | ---------------------------------- |
| 1   | `pruneStaleRuns` (`fetchedAt` older than the pass) | a run this pass did not refresh   | pushed out of the top 20,020       |
| 2   | `removeCharactersWithoutRuns`                      | characters no surviving run lists | every run of theirs has fallen off |

**The order is load-bearing**, exactly as steps 3–5 of the PvP cleanup are: stage 2 asks
which characters no surviving run names, so it has to run _after_ the runs are gone or every
character still looks current.

**Stage 2 is a referential check, not a timestamp check**, and that is the point. Once a
character keeps each dungeon's best run (§5.6), "not seen this pass" no longer means "gone"
— a character can be absent from a pass and still hold a legitimate score. Only being named
by no run at all means gone. It is the Mythic+ counterpart to
`RatingRepository.removeOrphans` and is computed the same way: read both key sets, difference
them, delete in chunks, rather than a `$nin` of thirty thousand keys or a `$lookup` per
document. The live set is aggregated rather than read with `distinct`, which caps its reply
at 16MB — a region is up to 20,020 runs × 5 members, and the deduplicated set fits today but
not with room to spare.

Both stages refuse to act on a region with no runs, for the reason `removeRetiredBrackets`
refuses an empty bracket list: that state means the pass failed, not that the ladder emptied.

### 5.8 Mythic+ catalogue and archive — `mplus_seasons`, `mplus_dungeons`, `mplus_archive_*`

```js
// mplus_seasons - every main season of every expansion
{ slug: 'season-df-2', name: 'DF Season 2', shortName: 'DF2', expansionId: 9,
  blizzardSeasonId: 10,                 // 0 for all of Legion; reference only
  starts: { us: Date, eu: Date, … }, ends: { us: Date, eu: Date, … },
  dungeonIds: [14032, 9391, …],         // details live in mplus_dungeons
  catalogueUpdatedAt: Date,
  archive: {                            // absent until the archive tries the season
    status: 'complete',                 // | 'incomplete' | 'partial' | 'unarchivable'
    pagesPlanned: 100,                  // per region
    pagesFetched: 500, failedPages: [], // failed pages as 'eu:7'
    runs: 10000, characters: 6100,      // totals over regions
    regions: {                          // one per region read
      us: { status: 'complete',         // | 'incomplete'
            pagesFetched: 100, failedPages: [], runs: 2000, characters: 1200,
            archivedAt: Date, source: 'fetched' },   // | 'adopted'
      eu: { … }, kr: { … }, tw: { … }, cn: { … } },
    archivedAt: Date, source: 'fetched', // 'adopted' only when every region was
    lastError? } }

// mplus_dungeons - one per dungeon, however many seasons ran it
{ id: 7805, slug: 'black-rook-hold', name: 'Black Rook Hold', shortName: 'BRH',
  challengeModeId: 199, keystoneTimerSeconds: 2340, iconUrl, backgroundImageUrl,
  expansionIds: [6, 8, 9, 10], updatedAt: Date }

// mplus_season_state       - per region: { region, season, name, startsAt, endsAt,
//                            ended, observedAt } - what was last observed (§4.6.2)
// mplus_season_transitions - { season, region, purgedAt, removed, triggeredBy, dryRun }

// mplus_archive_runs       - the shape of mplus_runs (§5.5): the region's own board,
//                            rank within the region
// mplus_archive_characters - the shape of mplus_characters (§5.5), score over the
//                            region's top runs only
```

**Main seasons only.** Raider.io lists 56 seasons; 35 are side events — break-the-meta weeks,
"post" tails, Legion Timewalking and Remix. None is archived, so none is catalogued: an entry
for one would describe a season the database holds no data for. `mainSeasonsOf` treats a
season with no `is_main_season` flag as main, since guessing "side event" would silently drop
a real season. Dungeons are taken from main seasons too, so every stored dungeon belongs to a
stored season — and nothing is lost by it, because the 21 main seasons list all 74 dungeons.

The walk's stopping rule is the one place side events still count. It stops at the first
expansion that lists **nothing**, decided before filtering: decided on main seasons alone, an
expansion listing only side events would end the walk and hide every expansion after it. A
unit spec pins this.

**Separate collections from the live ones**, as the PvP archive is (§5.4). The live
collections are rewritten, pruned and merged every pass, and a superseded season is deleted
from them once archived (§4.6.2). Sharing documents would put history within reach of every
cleanup written for the live board. An integration case runs a live pass over an archive and
asserts the archive is untouched.

**The catalogue and the marker share a document, and that is the one trap here.** A refresh
writes the catalogue fields with a field-level `$set` and never the whole document; a
wholesale replace would erase every marker, and the next tick would silently refetch the
entire archive. `toSeasonDocument` returns the document minus `archive` so the type makes the
mistake harder, and an integration case refreshes the catalogue over a finished archive and
asserts no request is made — the test that caught this when the replace was put back.

**The catalogue is refreshed; the archive is not.** Seasons change after the fact in exactly
one way that matters: a running season is listed with Raider.io's placeholder end
`2030-01-01`, replaced by the real date once it is over. A catalogue read once would never see
a season finish. Freshness is judged by the **oldest** `catalogueUpdatedAt`, not the newest —
a refresh that fails at expansion 8 stamps 6 and 7 fresh, and judged by the newest stamp the
catalogue would read as fresh while 8 onward stayed stale for a whole TTL.

**Dungeon ids are stable across expansions**: Black Rook Hold is 7805 in Legion, Shadowlands,
Dragonflight and The War Within; 31 of 74 dungeons recur. So `mplus_dungeons` holds one
document per id, `expansionIds` grows with `$addToSet`, and seasons reference ids. Affixes
work the same way and share `mplus_affixes` with the live pass — Legion's simply join it (30
affixes after a full archive).

**Archived `mythicScore` is narrower than the live one** (§5.5): at 100 pages it sums the
best run per dungeon among the **region's** top 2,000 runs, where the live board reads up to
20,020. Compare it only within a season and region, and only between characters with the same
`dungeonsCovered` — never with a live score. It is folded per region exactly as the live score
is, so raising `MPLUS_ARCHIVE_PAGES` to 1001 would make the two directly comparable.

Indexes — `mplus_seasons`: `season_identity` (unique `slug`), `season_expansion`.
`mplus_dungeons`: `dungeon_identity` (unique `id`). `mplus_archive_runs`:
`archive_run_identity` (unique `season+keystoneRunId`), `archive_run_board`
(`season+score`), `archive_run_region_board`, `archive_run_dungeon_board`,
`archive_run_roster`. `mplus_archive_characters`: `archive_character_identity` (unique
`season+key`), `archive_score_board`, `archive_score_region_board`,
`archive_character_lookup`.

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

**Quota: 100 requests/second, 36,000/hour.** Everything else follows from that. The hour is
governed by the shared budget (§4.0); the second by each job's own `RateLimiter`.

Retries get two budgets as well. A sweep is ~332 ladder fetches whatever the population,
so retrying one three times costs little and saves a bracket. Enrichment is one request per
character per half, so the same retry limit would multiply a far larger number.
Profile-namespace calls therefore use `PROFILE_RETRY_LIMIT` (1) rather than
`BLIZZARD_RETRY_LIMIT` (3); only the limit differs, so the same statuses are retryable
either way. Because retries are charged to the budget like any other attempt, a
retry-heavy run simply leaves less for the next one — it can no longer push the hour over.

Namespaces are derived per endpoint (`namespaceFor('profile', 'eu')` → `profile-eu`), not
configured. Character names must be lowercased and percent-encoded (`Zëph`).

### Failures the client classifies

| Condition            | Raised as                    | Seen by callers as         |
| -------------------- | ---------------------------- | -------------------------- |
| non-2xx              | `BlizzardApiError`           | the status; 404 is routine |
| empty 2xx body       | `BlizzardEmptyResponseError` | transient; no HTTP status  |
| unparseable 2xx body | the underlying parse error   | transient at this layer    |
| schema mismatch      | `ZodError`, at the API layer | **permanent** — see §4.2   |

The empty-body case is the one worth knowing about. `got` resolves an empty body to `''`
instead of raising a parse error, so without an explicit check it flows on and only fails at
the zod boundary — indistinguishable there from Blizzard shaping a payload wrongly, and
therefore classified as permanent. It is caught in `BlizzardHttpService`, which is the last
place that still knows the response was a 200 carrying nothing, and it counts against
Blizzard's observed health rather than for it: a gateway shedding load answers exactly this
way, and recording it as a success is how readiness reports green through an outage.

### 6.1 Raider.io API surface

All calls go through `RaiderIoHttpService`: one shared got instance, the access key injected
per request, retries on 408/429/5xx, per-second pacing and per-attempt budget accounting.
Non-2xx becomes `RaiderIoApiError` with `statusCode`, `isNotFound` and `isBadRequest`.

| Endpoint                                                  | Used by                                                         |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| `/api/v1/mythic-plus/runs?season&region&dungeon=all&page` | the M+ pass — 1,001 pages a region                              |
| `/api/v1/mythic-plus/static-data?expansion_id`            | the current season; the whole catalogue, one call per expansion |
| `/api/v1/mythic-plus/runs?…&region=<region>` (archive)     | the archive — 100 pages a region, a finished season             |

**The access key travels as a query parameter**, which Raider.io requires and which means it
lands inside every url — including the ones got bakes into its own error messages. It is
therefore added in `beforeRequest`, exactly where the bearer token is added for Blizzard, so
no url this class builds, logs or reports contains it; `DependencyHealth` redacts it as a
second line of defence for messages the client did not build. **An integration case asserts
the key appears nowhere in `/health/ready`.**

**The token bucket lives in the HTTP client, not in the job.** `RAIDERIO_MINUTE_LIMIT` is a
per-minute ceiling, so pacing has to hold across every call site sharing the budget, not just
the one loop that happens to be the biggest spender — the mistake §4.0 records, one layer
down. It is acquired before the request, never inside the hook: the hook runs again for each
retry and sleeping in it would hold got's own backoff open on top of the wait already taken.

#### Failures the client classifies

| Condition       | Raised as                    | Seen by callers as                              |
| --------------- | ---------------------------- | ----------------------------------------------- |
| **400**         | `RaiderIoApiError`           | **end of the data** — not retried, not an error |
| 404             | `RaiderIoApiError`           | routine (unknown season/region)                 |
| other non-2xx   | `RaiderIoApiError`           | the status                                      |
| empty 2xx body  | `RaiderIoEmptyResponseError` | transient; no HTTP status                       |
| schema mismatch | `ZodError`, at the API layer | a failed page; the region is not pruned         |

The `400` row is the one that is specific to this upstream: the runs endpoint answers `400`
rather than an empty page once `page` passes 1000, so retrying it would be three wasted
requests for a reply that cannot change — which is why 400 is **absent** from the retryable
statuses while 408/429/5xx are present.

The empty-body case exists for the same reason as Blizzard's (§6): `got` resolves an empty
body to `''` instead of raising, so without an explicit check it would only fail at the zod
boundary, indistinguishable there from payload drift. It matters more here, not less —
Raider.io sits behind Cloudflare, which is exactly the kind of front that answers
200-with-nothing while shedding load.

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

| Condition                               | `status`   | HTTP    |
| --------------------------------------- | ---------- | ------- |
| everything healthy                      | `ok`       | **200** |
| Blizzard failing (any/all regions)      | `degraded` | **200** |
| **Raider.io failing (any/all regions)** | `degraded` | **200** |
| no sweep for 2× `INGEST_INTERVAL_MS`    | `degraded` | **200** |
| enrichment infeasible or behind         | `degraded` | **200** |
| **M+ infeasible, failing or cut short** | `degraded` | **200** |
| Mongo unreachable                       | `down`     | **503** |

Mongo is a **hard** dependency; Blizzard and Raider.io are both **soft** ones. Without Mongo the service can
do nothing, so readiness fails and traffic should be withdrawn. Without Blizzard it still
holds every row already ingested, so only ingestion is degraded — failing readiness there
would have an orchestrator restart-loop the service through an incident it cannot fix.
**Do not "fix" the Blizzard case into a 503.**

Readiness also carries `quota` — the rolling-hour spend per job, current allowances and
shares — `enrichment`, the outlook from the last run plus any `problems` in plain words, and
their Raider.io counterparts `raiderIoQuota` and `mplus`. All four are read from memory, so
none adds I/O to a probe.

`mplus.problems` separates two distinct failures, deliberately not folded together:
`feasible: false` is arithmetic — a full pass cannot finish inside its own interval, so the
configured cadence is a fiction and no amount of waiting fixes it — while `pagesFailed` and
`stoppedEarly` describe a pass that did not complete. Neither fails readiness: the runs
already stored still serve. `MplusOutlook` is the Raider.io counterpart to
`EnrichmentOutlook`, published by the job on each pass.

Two further rules this endpoint must keep:

- **Never probe Blizzard.** State is recorded passively by `BlizzardHttpService` on real
  calls. The endpoint is unauthenticated, so an active probe per hit would be free
  amplification into a metered third-party API.
- **Never leak a credential.** The Mongo host is reported, never the URI, and every
  reported string passes through `redactSecrets` — driver connection errors routinely echo
  the whole connection string.

### `GET /health/seasons`

Per-region season detail plus the read-only season-transition `plan()`, and under `mplus`
the same pair for Mythic+: what was last observed per region and the M+ transition `plan()`
(current season per region, `candidates`, `blockedByArchive`). Kept off the readiness path
because both read the database. Liveness (`GET /health`) carries `mplusSeasons` from memory.

### `POST /admin/*` — dev-only job triggers

`sweep`, `enrich`, `snapshot`, `archive`, `archive-rewards`, `mplus`, `mplus-season`,
`mplus-season-transition`, `mplus-archive`, `mplus-catalogue`, `season-refresh`,
`season-transition`. Each drives
exactly **one** cycle and returns that cycle's own result object. Every route **404s when
`NODE_ENV=production`**.

They exist because the alternative — shrinking the intervals through configuration — makes
every job race every other one, so a runtime rehearsal stops being a controlled
observation.

`mplus-archive` runs one archive tick directly, so it runs whatever else is active — a
rehearsal is the point — though it still yields between batches if a higher-priority job
starts. `mplus-catalogue` re-reads the catalogue ignoring its TTL. `mplus-season` does that
and then observes the season per region, announcing an end or rollover exactly as the
scheduled check would. `mplus-season-transition` plans and runs the M+ transition, honouring
its dry-run flag.

Liveness also carries `jobs.archiveRunning`, `jobs.mplusArchiveRunning` and
`jobs.mplusArchive` — the archive's last tick (seasons attempted, still pending, why it
stopped) from memory. It is **reported, never judged**: a season still owed is history that
has already waited years, and no state of the archive makes the service less able to serve,
so it cannot degrade readiness.

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

### `POST /mplus/characters/sync`

The Mythic+ counterpart, for the same reason: a search API keeping `mplus_characters`
current without waiting for the next pass.

```http
{ "season": "season-mn-2", "region": "us",
  "realmSlug": "area-52", "characterName": "Skollcat",
  "dungeonRuns": [ { "dungeon": { "id": 9527, "name": "…", "slug": "…", "shortName": "TOS" },
                     "keystoneRunId": 11626563, "mythicLevel": 22, "score": 515.3,
                     "clearTimeMs": 1906389, "timeRemainingMs": 14610, "numChests": 1,
                     "completedAt": "2026-09-13T08:00:10.000Z", "specId": 62, "role": "dps" } ],
  "profile": { "specId": 63, "specName": "Fire" } }
→ 200 { "key": "us/area-52/skollcat", "dungeonRuns": 1, "addedDungeons": 1,
        "mythicScore": 4227.6, "dungeonsCovered": 9 }
```

| Response | Meaning                                                |
| -------- | ------------------------------------------------------ |
| 200      | Merged; the body reports what the merge settled on     |
| 400      | Invalid payload (every offending field listed)         |
| 404      | No such character — **the endpoint never creates one** |
| 409      | A Mythic+ pass is running; retry when it finishes      |

It follows the PvP endpoint's three rules — never creates a character, refuses to interleave
with the job that owns the same documents, recomputes every derived field — and differs in
exactly one, which a caller has to know:

- **`dungeonRuns` is merged, not authoritative.** On the PvP side an omitted bracket means
  "left that ladder" and its rating row is deleted. Here omission means "nothing new to
  say": the stored entry is kept. That is not a convenience, it is §5.6 — monotonicity is a
  property of the data rather than of one code path, so there is no payload that lowers a
  score. A worse run for a dungeon already held is accepted and changes nothing; a better
  one replaces it. **An empty `dungeonRuns` is therefore a valid profile-only update**,
  where the PvP endpoint rejects an empty `brackets` outright.
- `profile` is merged field by field — absent leaves the stored value, explicit `null`
  clears it — as on the PvP side.
- `mythicScore`, `dungeonsCovered` and `key` are **not accepted**; they are derived from
  `dungeonRuns` and the identity fields, which is the only way they cannot drift. Unknown
  keys are stripped, so a document read from Mongo can be posted back unchanged.
- The 409 is a real interlock rather than a courtesy: the pass's own write is a
  read-merge-write, so a push landing between its two halves would lose whichever arrived
  first.

> **To lower a score there is no endpoint.** Delete the character and let the next pass
> rebuild it from the board. That is deliberate — see §5.6.

**No authentication**, exactly as above.

---

## 8. Configuration

Every variable is validated by zod at boot; anything missing or malformed fails fast.

| Variable                              | Default                             | Notes                                                      |
| ------------------------------------- | ----------------------------------- | ---------------------------------------------------------- |
| `BLIZZARD_CLIENT_ID` / `_SECRET`      | —                                   | **Required**                                               |
| `BLIZZARD_REGION`                     | `us`                                | OAuth host region only (`us,eu,kr,tw,cn`)                  |
| `BLIZZARD_REGIONS`                    | `us,eu,kr,tw`                       | Ladders to ingest — distinct from the above                |
| `BLIZZARD_LOCALE`                     | `en_US`                             |                                                            |
| `BLIZZARD_API_HOST_TEMPLATE`          | `https://{region}.api.blizzard.com` | Must contain `{region}`; the L3 test seam                  |
| `BLIZZARD_REQUEST_TIMEOUT_MS`         | `30000`                             |                                                            |
| `BLIZZARD_RETRY_LIMIT`                | `3`                                 | Ladder and season endpoints                                |
| `PROFILE_RETRY_LIMIT`                 | `1`                                 | Per-character endpoints; lower on purpose                  |
| `BLIZZARD_CONCURRENCY`                | `8`                                 | Parallel bracket fetches per sweep                         |
| `MONGODB_URI`                         | —                                   | **Required**                                               |
| `MONGODB_DB`                          | `rankwarden`                        |                                                            |
| `INGEST_INTERVAL_MS`                  | `3600000`                           |                                                            |
| `INGEST_RUN_ON_STARTUP`               | `true`                              |                                                            |
| `PROFILE_ENRICHMENT_ENABLED`          | `true`                              | `false` releases the archive warm-up gate                  |
| `PROFILE_INTERVAL_MS`                 | `300000`                            |                                                            |
| `PROFILE_BATCH_SIZE`                  | `2000`                              | Per-run ceiling; the batch itself is computed              |
| `PROFILE_SUMMARY_TTL_MS`              | `604800000`                         | 7 days                                                     |
| `PROFILE_SPECS_TTL_MS`                | `86400000`                          | 1 day                                                      |
| `PROFILE_CONCURRENCY`                 | `8`                                 |                                                            |
| `PROFILE_RETRY_BACKOFF_MS`            | `900000`                            | Wait after a transient enrichment failure                  |
| `PROFILE_REQUESTS_PER_SECOND`         | `20`                                | Token bucket                                               |
| `SEASON_REFRESH_ENABLED`              | `true`                              | Off switch for the daily season re-check                   |
| `SEASON_REFRESH_INTERVAL_MS`          | `86400000`                          |                                                            |
| `SEASON_TRANSITION_ENABLED`           | `true`                              | Retiring finished seasons                                  |
| `SEASON_TRANSITION_CHECK_INTERVAL_MS` | `3600000`                           | A rollover also ticks immediately                          |
| `SEASON_PURGE_REQUIRE_ARCHIVE`        | `true`                              | Only purge what the archive holds in full                  |
| `SEASON_PURGE_DRY_RUN`                | `true`                              | Log the plan, delete nothing; set `false` to arm           |
| `REPRESENTATION_ENABLED`              | `true`                              |                                                            |
| `REPRESENTATION_CHECK_INTERVAL_MS`    | `3600000`                           |                                                            |
| `REPRESENTATION_MIN_RATINGS`          | `1500,1800,2100,2300,2700`          | Cutoffs to track                                           |
| `ARCHIVE_ENABLED`                     | `true`                              |                                                            |
| `ARCHIVE_CHECK_INTERVAL_MS`           | `3600000`                           |                                                            |
| `ARCHIVE_SEASON_PAUSE_MS`             | `5000`                              | Breather between seasons                                   |
| `ARCHIVE_CONCURRENCY`                 | `4`                                 |                                                            |
| `ARCHIVE_REQUESTS_PER_SECOND`         | `10`                                |                                                            |
| `ARCHIVE_MIN_SEASON` / `_MAX_SEASON`  | `0` / `0`                           | 0 = unbounded; the real size lever                         |
| `ARCHIVE_MAX_ENTRIES_PER_BRACKET`     | `5000`                              | Top N by rating; saves only ~1%                            |
| `NODE_ENV` / `PORT` / `LOG_LEVEL`     | `development` / `3000` / `log`      |                                                            |
| `QUOTA_HOURLY_LIMIT`                  | `36000`                             | Blizzard's cap on the whole client                         |
| `QUOTA_UTILISATION`                   | `0.9`                               | Fraction ever planned against                              |
| `QUOTA_ENRICHMENT_HEADROOM`           | `3`                                 | Enrichment plans at most cap / this                        |
| `QUOTA_SWEEP_RESERVE`                 | `1000`                              | Held back for the sweep each hour                          |
| `RAIDER_IO_API_KEY`                   | —                                   | **Required when `MPLUS_ENABLED=true`**                     |
| `RAIDERIO_API_BASE_URL`               | `https://raider.io/api/v1`          | The test seam for the second upstream                      |
| `RAIDERIO_REGIONS`                    | `us,eu,kr,tw,cn`                    | Includes `cn`; `world` is rejected                         |
| `RAIDERIO_REQUEST_TIMEOUT_MS`         | `30000`                             | Also caps `Retry-After`                                    |
| `RAIDERIO_RETRY_LIMIT`                | `2`                                 | 408/429/5xx only — never 400                               |
| `RAIDERIO_CONCURRENCY`                | `12`                                | Pages in flight; ~0.65s a page measured                    |
| `RAIDERIO_PAGE_BATCH`                 | `50`                                | Memory bound, and how often budget/priority are re-checked |
| `RAIDERIO_MAX_PAGES`                  | `1001`                              | The whole leaderboard; the `mythicScore` lever             |
| `RAIDERIO_MINUTE_LIMIT`               | `1000`                              | Raider.io's cap on the whole client                        |
| `RAIDERIO_UTILISATION`                | `0.9`                               | Fraction ever planned against                              |
| `RAIDERIO_REQUESTS_PER_SECOND`        | `14`                                | Token bucket; must fit inside the minute                   |
| `MPLUS_ENABLED`                       | **`false`**                         | Opt-in — it needs a credential older deploys lack          |
| `MPLUS_INTERVAL_MS`                   | `21600000`                          | 6h; ~5,005 requests a pass at five regions                 |
| `RAIDERIO_ARCHIVE_SHARE`              | `0.5`                               | Most of each minute the archive may spend (§4.0.1)         |
| `RAIDERIO_BUDGET_WAIT_MS`             | `60000`                             | Wait for a spent minute before giving up; 0 = stop at once |
| `MPLUS_ARCHIVE_ENABLED`               | **`false`**                         | Opt-in — needs `RAIDER_IO_API_KEY`                         |
| `MPLUS_ARCHIVE_CHECK_INTERVAL_MS`     | `3600000`                           | Cheap once history is in                                   |
| `MPLUS_ARCHIVE_PAGES`                 | `100`                               | Pages per region per season: 2,000 runs a region           |
| `MPLUS_CATALOGUE_FIRST_EXPANSION`     | `6`                                 | Legion; the walk continues until an empty expansion        |
| `MPLUS_CATALOGUE_TTL_MS`              | `86400000`                          | How a new or finished season is noticed (§5.8)             |
| `MPLUS_SEASON_REFRESH_ENABLED`        | `true`                              | Catalogue at boot + hourly season check; idle without M+   |
| `MPLUS_SEASON_CHECK_INTERVAL_MS`      | `3600000`                           | No request unless the catalogue is due                     |
| `MPLUS_TRANSITION_ENABLED`            | `true`                              | Retire superseded M+ seasons (§4.6.2)                      |
| `MPLUS_TRANSITION_CHECK_INTERVAL_MS`  | `3600000`                           | A rollover also ticks, after any running pass              |
| `MPLUS_PURGE_REQUIRE_ARCHIVE`         | `true`                              | Only once the M+ archive holds the season                  |
| `MPLUS_PURGE_DRY_RUN`                 | **`false`**                         | Unlike the PvP flag — see §4.6.2                           |

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

A sixth path, the season purge (§4.8), is separate: it retires a whole finished season and
is gated on the _next_ season starting, not on a sweep.

### 9.9 Raider.io's character id is not Blizzard's

Cross-checked against the Blizzard profile API on 2026-09-14 (§5.1 has the four pairs).
Both are nine-digit integers in the same range, so writing one where the other is expected
produces a collision that nothing reports. `realm.wowRealmId` **is** Blizzard's realm id,
which makes the mismatch easier to miss — one id in the payload maps across and the other
does not.

**Consequence:** a character cannot be joined between `characters` and `mplus_characters`
by id. Join on `region + realmSlug + lowercased name`, which is what
`mplusCharacterKey()` builds and what `mplus_characters` is keyed on.

### 9.10 One roster entry in 200 is anonymised, and they all share `id: 0`

Players who opt out of public Raider.io profiles arrive as:

```js
{ id: 0, name: 'Anon12627389', anonymized: true,
  realm: { id: 0, slug: 'anonymous', anonymized: true } }   // no wowRealmId
```

Measured 10 of 2,000 roster rows (0.5%) across a spread of pages and regions. Two things
follow. **The realm omits `wowRealmId`** — along with `altName`, `locale` and `realmType` —
so a schema requiring any of them fails the _whole page_, and at that rate nearly every page
carries one. And **`id: 0` is shared by all of them**, so keying anything on it folds every
anonymous player in a region into one document.

They are kept in `mplus_runs.roster` and excluded from `mplus_characters` (§5.5). Invariant
I14 asserts the exclusion; a unit case asserts `isAnonymised` still works with both
`anonymized` flags removed, so the fallback signals are not merely present but tested.

### 9.11 The M+ leaderboard only publishes timed runs

Every run in a 2,000-run sample was `status: "finished"` with `num_chests >= 1` and
`time_remaining_ms > 0`. `timeRemainingMs` is stored because "timed by 14 seconds" and
"timed by 8 minutes" are very different runs — but it does **not** distinguish a timed run
from a depleted one, because a depleted one never appears. A UI must not present it as
a pass/fail flag.

### 9.12 `is_main_season` excludes side events

`season-mn-1-break-the-meta` ran for a week _inside_ season 1, with its own slug and its own
leaderboard. Picking the newest season by start date alone would have swapped the whole
ladder out for a week and swapped it back. Side events never reach the catalogue
(`mainSeasonsOf`), so `currentSeasonIn` only ever chooses among main seasons — the newest
one already opened **in that region**, because regions stagger by up to 32 hours exactly as
PvP seasons do (§4.8).

### 9.13 `static-data` is per expansion

`static-data?expansion_id=6` answers with **Legion's six seasons and nothing else**. The full
history is one call per expansion: 6 (Legion) to 11 (Midnight) today, with 5 answering
dungeons but no seasons and 12 answering nothing. The catalogue therefore walks upward from
`MPLUS_CATALOGUE_FIRST_EXPANSION` and stops at the first expansion with no seasons, so a new
expansion needs no change. A **failed** expansion also stops the walk rather than being
skipped: skipped, a transient failure on expansion 8 would look identical to 8 having ended
the list, and 9 onward would silently go unrefreshed.

### 9.14 Old payloads carry placeholders the current ones do not

Two shapes found only by archiving the **whole** history against the real API, each of which
failed its page and would have left a season `incomplete` forever. Sampling four pages of
three seasons per era had passed cleanly — which is why the rehearsal read everything.

| Field                     | Observed in                            | Shape                                            | Read as |
| ------------------------- | -------------------------------------- | ------------------------------------------------ | ------- |
| `character.spec` / `race` | `season-7.2.5` (1 run in 20 on a page) | `{ "name": "", "slug": "" }` — no id, empty name | `null`  |
| `realm.wowRealmId`        | `season-df-2`, `eu-mythic-dungeons`    | `null`, on a `realmType: "tr"` tournament realm  | `null`  |

The second is the §9.5 trap again: the field was `.optional()`, which accepts _absent_ (the
anonymised realm) and rejects `null` (the tournament realm). Every non-identity realm field
is now `.nullish()`. Tournament-realm characters are real — the MDI is played there — so they
are stored with `realmId: null` rather than skipped; 26 of them in a full archive.
`character.class` is deliberately still required: a run cannot be displayed without it, and a
class placeholder is worth failing loudly on.

### 9.15 Rosters are not always five

Most are, but two of thirteen sampled seasons had a 399-member page, and Raider.io publishes a
`season-tww-3-legion-remix-1-player` board. Nothing in the schema or the fold assumes five; do
not introduce anything that does.

---

## 10. Testing

Two Vitest projects, because the layers have different prerequisites.

| Command            | Project       | Covers                                                      | Needs   |
| ------------------ | ------------- | ----------------------------------------------------------- | ------- |
| `npm test`         | `unit`        | `src/**/*.spec.ts` — pure functions, mocked DI              | nothing |
| `npm run test:int` | `integration` | `test/**/*.spec.ts` — real Mongo, fake Blizzard + Raider.io | Docker  |
| `npm run test:all` | both          |                                                             | Docker  |

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
| `mplus-world.ts`   | Mutable model of Raider.io: seasons, runs, rosters.                      |
| `fake-raiderio.ts` | Replaces `RaiderIoHttpService`, serving the M+ world as raw JSON.        |
| `app.ts`           | `bootTestApp` — real `AppModule`, real Mongo, both fakes.                |
| `invariants.ts`    | `expectInvariants` and the individual I1–I20 checks.                     |
| `database.ts`      | Test database naming and the guard below.                                |
| `http.ts`          | `fetch` against a real listener; no supertest dependency.                |
| `seams.ts`         | Every scheduler whose bootstrap work can be awaited.                     |

**The fake sits at the HTTP seam, not at `PvpApi`.** That keeps `PvpApi`, `ProfileApi` and
every zod schema inside the test, which is where the payload traps of §9.5 live. The fake
reproduces them deliberately: `leaderboards[].id` on the first entry only, and
`season_end_timestamp` absent rather than null while a season runs.

`FakeRaiderIo` is built the same way and reproduces its own upstream's quirks: an anonymised
realm with `wowRealmId`, `altName`, `locale` and `realmType` **absent** (§9.10), a `null`
`loadout`, a `400` rather than an empty page past `page` 1000, and an empty `rankings` array
for a region shallower than the page ceiling. Like `FakeBlizzard` it is handed the real
`DependencyHealth` **and** the real `RaiderIoBudget` by `bootTestApp` — without both, every
test would run against a budget that never fills and readiness would report `unknown` for
Raider.io forever.

`test/setup/integration-env.ts` points `RAIDERIO_API_BASE_URL` at a dead port and sets a
placeholder key, for the same reason it does so for Blizzard: a missed seam must fail
locally rather than spend the owner's real Raider.io allowance.

Four M+ files, split by the one-configuration-per-file rule: `mplus-ingestion.spec.ts`
(the pass, the score fold, both cleanup stages, monotonicity, idempotence),
`mplus-failures.spec.ts` (budget exhaustion, failed pages, empty bodies, the prune guard and
the cleanup's own guard), `mplus-coordination.spec.ts` (job priority, readiness, key
redaction, moving onto a new season) and `mplus-sync.spec.ts` (the endpoint).

`mplus-season-transition.spec.ts` tells one season's life in order, with the season check
and the transition switched on: the catalogue read at boot with no runs requested; a pass
reading a missing catalogue before its first runs request; a season ending in one region and
staying live without churn, unarchived; the next season opening in the US only, the US
rolling alone and its old board held by the archive interlock; the archive taking the old
season and only the US being retired; Europe opening it and being retired by the rollover
event with nothing calling the transition; and a rollover during downtime recognised at the
next boot (`acrossRestart`). Dates are relative to the real clock. The rollover-during-a-pass
wait is pinned by `mplus-season-transition.scheduler.spec.ts`, since the story never meets it
with an archived season to retire.

Two more for the archive. `mplus-archive.spec.ts` drives it by hand: the catalogue walk,
main-season selection, per-region depth and ranks, never asking for `world`, a region with no
board, fetch-once, markers surviving a catalogue refresh, per-region adoption and its refusal
of ambiguous rows, `incomplete` retrying only the failed region, `unarchivable`, yielding to
each job above it before, **during** and **between** regions (keeping the regions read), a
`world`-era marker re-read per region, and a live pass running beside the archive. `mplus-archive-scheduler.spec.ts` switches the archive and the live pass on and
proves the real boot order: nothing at boot, then the live pass, then the archive — every
live request before every archive one.

`MplusWorld` grew for it: seasons carry `expansionId`, `ends` and `firstDungeonId`; runs carry
an optional `season` so one archived board does not leak into another (absent means every
season, which the live-pass files rely on); runs carry optional `affixes`, so an old
season's board can rotate weekly sets the way `season-sl-4`'s does (absent means Tyrannical
and Fortified); `unservedSeasons` answers 404; `region=world` answers 404, so a regression to
the aggregate board fails loudly. `FakeRaiderIo.beforeServe` runs as each request is served, which is how a
test starts a higher-priority job partway through a season at a moment the archive cannot
see coming.

I12–I14 now take a collection and run against the archive too. I19 asserts a `complete`
marker describes exactly the rows stored for it, region by region and in total; I20 that every dungeon a season lists is
catalogued. All five were also checked against the real, full archive during the rehearsal.

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

**Adding a third upstream.** The pattern is now established rather than improvised, and
Raider.io is the worked example: a module under `src/<upstream>/` with `http/`, `schemas/`
and a typed `*.api.ts`; its **own** budget built on `RollingWindow` (never a share of
another upstream's); a `RunKind` in `run-context.ts` plus a `consumerFor` mapping; a
provider key in `DependencyHealth` so it reports **soft**; a readiness block read from
memory; a fake at the HTTP seam wired into `bootTestApp` with both the health instance and
the budget; the scheduler added to `test/support/seams.ts`; and a slot in
`IngestionCoordinator` decided deliberately rather than by omission. Check
`quotaConsumerFor` too: a new `RunKind` falls into Blizzard's never-throttled `other`
bucket by default, which is only correct if the job makes no Blizzard requests.

**Adding a job that shares an upstream budget with another.** The Mythic+ archive is the
worked example. Give it its own consumer and a **capped share** (`allowanceFor`), so it cannot
fill a window a higher-priority job is about to need; have both **wait** for a spent window
(`waitForAllowance`) rather than stop, bounded by one window; and give the lower one an
`abandon` that releases the wait the moment anything above it starts.

**Validating a schema against history.** Read everything the job will read, not a sample.
Both placeholders in §9.14 were invisible at four pages per season and surfaced only in a
full read; the full archive is ~2,000 requests and five minutes. Drop the rehearsal database
afterwards.

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
- **The season purge is irreversible and fires at boot on a first deploy** (§4.8). Ship
  behind `SEASON_PURGE_DRY_RUN=true` and read the logged plan before flipping it.
- **Cross-region boards need four queries merged**, or a `seasonId + rating` index; the
  current index is prefixed by region.
- **`mplus_characters.mythicScore` is not Raider.io's mythic+ score** (§5.5). It sums only
  the runs on the ingested leaderboard, so it ranks leaderboard presence and is comparable
  only between characters with the same `dungeonsCovered`. Per-dungeon fetching would fix
  it at 8x the requests (32,032 a pass at five regions instead of 5,005).
- **M+ and PvP records for the same player are not joined.** They live in separate
  collections with no shared id (§9.9); join on `region + realmSlug + lowercased name`.
- **Anonymised M+ players are reachable only through a run's roster**, never as characters
  (§9.10). There is no way to give them a board entry, and nothing is lost by it.
- **The Raider.io rate limit is configuration, not a negotiated value.** No rate-limit
  header is exposed on a success, so `RAIDERIO_MINUTE_LIMIT` is a stated figure with a
  measured floor (300 requests, no 429). If Raider.io tightens it, the first sign will be
  429s in the logs rather than anything readiness could have predicted.
- **A full M+ pass is ~5,005 requests and ~100,000 runs written**, roughly 150MB a pass at
  five regions. The whole ladder is rewritten each time rather than diffed, which is what
  makes `mythicScore` recomputable but means the write volume does not fall as the season
  settles.
- **`mythicScore` only rises, so a correction needs a delete.** There is no pass and no
  payload that lowers one (§5.6). If bad data inflates a score — a payload bug, a bad
  manual sync — the character has to be deleted and rebuilt by the next pass. Watch
  `mergedCharacters` in the pass result: it climbing steadily means the ingested window is
  falling behind the ladder rather than that anything is wrong.
- **A kept dungeon can outlive the run it names.** `dungeonRuns[].keystoneRunId` may point
  at a pruned run, so the join into `mplus_runs` is optional by design (§5.6). A UI that
  assumes it resolves will show gaps.
- **A character with no runs left loses their peak score entirely.** Stage 2 of the cleanup
  deletes them (§5.7), so a player who drops off the board and returns later starts from
  what the board then shows rather than from what they had. Keeping them would mean an
  ever-growing collection of players no board ranks.
- **The Mythic+ archive is shallow by design.** 100 pages is each region's top 2,000 runs,
  so archived `mythicScore` covers fewer dungeons per character than the live one and is
  comparable only within a season and region (§5.8). Title cutoffs read from it are exact
  only while the cutoff sits inside that window — the top of each region. Deepening it later
  means raising `MPLUS_ARCHIVE_PAGES` and clearing the `archive` markers so the seasons are
  read again.
- **Side-event seasons are neither catalogued nor archived.** Adding them later means
  storing them in the catalogue again (`mainSeasonsOf` in `MplusCatalogueService.refresh`)
  and archiving them — 35 seasons, about 3,500 more requests.
- **A new Mythic+ season is noticed up to a catalogue TTL late** if Raider.io lists it only
  after it has opened. Normally it is listed days ahead and the switch happens within the
  hour of opening (the season check) or at the next pass. `POST /admin/mplus-season` forces it.
- **An undated season is never current.** A catalogued season with no parseable start in any
  region cannot be placed against the others, so it is skipped rather than guessed at. Not
  observed in the real catalogue.
- **The live board keeps only the archive's copy of a retired season.** The archive is 100
  pages a region; the live board was up to 1,001. Retiring a season trades that
  depth for storage, by design — disable `MPLUS_TRANSITION_ENABLED` to keep it.
- **An archived season is never re-read.** If Raider.io corrects a finished season's board
  after it was archived, the archive keeps the version it read. Clear the season's `archive`
  field to fetch it again.
- **A catalogue season Raider.io stops listing keeps its old stamp**, and freshness is judged
  by the oldest stamp (§5.8), so the catalogue would then be refreshed on every tick — seven
  requests an hour. Not observed; delete the stale season document if it happens.
