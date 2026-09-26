# Mythic+ — implementation map for testing

Written for the agent that builds and runs a test plan for the Mythic+ side of this service.
It is a map of what exists, what each part promises, what is already pinned by a test, and
what is not. It does not restate design reasoning: [`SKILLS.md`](SKILLS.md) is the canonical
reference and every section below points into it.

Read this with §4.6, §4.6.1, §4.6.2, §5.5–§5.10, §6.1, §9.9–§9.15 and §10 of `SKILLS.md`.

---

## 1. The parts, and what triggers each

| # | Part                         | Entry point                                    | Runs when                                              | Upstream cost                    |
| - | ---------------------------- | ---------------------------------------------- | ------------------------------------------------------ | -------------------------------- |
| 1 | **Season catalogue**         | `MplusCatalogueService.refresh(IfDue)`          | boot, then `MPLUS_CATALOGUE_TTL_MS`; before any pass    | 1 request per expansion (7)      |
| 2 | **Season check**             | `MplusSeasonService.observe` via `MplusSeasonScheduler` | boot + `MPLUS_SEASON_CHECK_INTERVAL_MS`         | none unless the catalogue is due |
| 3 | **Live pass**                | `MplusService.sweep()`                          | `warmedUp$`, then `MPLUS_INTERVAL_MS`                   | ≤1,001 pages a region            |
| 4 | **Season transition**        | `MplusSeasonTransitionService.run()`            | `MPLUS_TRANSITION_CHECK_INTERVAL_MS` + on rollover      | none                             |
| 5 | **Archive**                  | `MplusArchiveService.archiveBacklog()`          | both warm-ups, then `MPLUS_ARCHIVE_CHECK_INTERVAL_MS`   | 100 pages a region a season      |
| 6 | **Spec representation**      | `MplusSpecRepresentationService`                | end of each pass; once per archived season              | none (database only)             |
| 7 | **Season cutoffs**           | `MplusCutoffsService`                           | end of each pass; once per archived season              | 1 request a region a season      |
| 8 | **Sync endpoint**            | `POST /mplus/characters/sync`                   | on request                                              | none                             |

Priority (`IngestionCoordinator`, §4): PvP sweep → enrichment → **live pass** → PvP archive →
**M+ archive**. The M+ archive yields to everything, including between page batches.

Source layout: `src/mplus/` (the pass), `src/mplus-season/` (catalogue, current season,
transition, cutoffs), `src/mplus-archive/` (finished seasons), `src/mplus-representation/`,
`src/sync/mplus-character-sync.*`.

---

## 2. Collections, and who writes them

| Collection                  | Written by                    | Identity (unique)                 |
| --------------------------- | ----------------------------- | --------------------------------- |
| `mplus_runs`                | live pass                     | `season + region + keystoneRunId` |
| `mplus_characters`          | live pass, sync endpoint      | `season + key`                    |
| `mplus_affixes`             | live pass **and** archive     | `id`                              |
| `mplus_seasons`             | catalogue, archive, cutoffs   | `slug`                            |
| `mplus_dungeons`            | catalogue                     | `id`                              |
| `mplus_archive_runs`        | archive                       | `season + keystoneRunId`          |
| `mplus_archive_characters`  | archive                       | `season + key`                    |
| `mplus_spec_representation` | live pass, archive            | `season + region + dungeonId`     |
| `mplus_season_state`        | season check / pass           | `region`                          |
| `mplus_season_transitions`  | season transition             | `season + region`                 |

`mplus_seasons` is written by three jobs at once, each with a **field-level `$set`**: the
catalogue writes the season fields, the archive writes `archive`, the cutoffs write
`cutoffs.<region>`. A whole-document replace by any of them is a regression (§5.8).

Shapes: §5.5 (runs, characters), §5.8 (seasons, dungeons, archive marker), §5.9
(representation), §5.10 (cutoffs).

---

## 3. Behaviour rules worth a test

Each rule is a promise the code makes. "Covered" names the spec that fails if the rule is
broken — verified by breaking each one deliberately. Rules with **no** coverage are the
starting point for new tests.

### 3.1 Catalogue and current season (§4.6.2, §5.8)

| Id  | Rule                                                                                       | Covered by                              |
| --- | ------------------------------------------------------------------------------------------ | --------------------------------------- |
| C1  | Walks expansions from `MPLUS_CATALOGUE_FIRST_EXPANSION` upward, stopping at the first with no seasons | `mplus-catalogue.service.spec.ts`, `mplus-archive.spec.ts` |
| C2  | The stop is decided **before** side events are filtered out                                 | `mplus-catalogue.service.spec.ts`       |
| C3  | Only main seasons are stored; dungeons come from main seasons                               | `mplus-catalogue.service.spec.ts`, `mplus-archive.mapper.spec.ts` |
| C4  | A failed expansion stops the walk rather than being skipped                                 | — (unit gap)                            |
| C5  | A refresh never erases `archive` or `cutoffs` on a season                                   | `mplus-archive.spec.ts`                 |
| C6  | Freshness is judged by the **oldest** `catalogueUpdatedAt`                                  | — (gap)                                 |
| C7  | One refresh is shared between simultaneous callers                                          | `mplus-catalogue.service.spec.ts`       |
| C8  | Current season per region = newest catalogued season **opened in that region**              | `mplus-catalogue.mapper.spec.ts`, `mplus-season-transition.spec.ts` |
| C9  | An ended season stays current until its successor opens there                               | `mplus-catalogue.mapper.spec.ts`, `mplus-season-transition.spec.ts` |
| C10 | A season with no parseable start is never current                                           | `mplus-catalogue.mapper.spec.ts`        |
| C11 | `ended` and `rollover` are announced once each, per region                                  | `mplus-season.service.spec.ts`, `mplus-season-transition.spec.ts` |
| C12 | A rollover during downtime is recognised at boot (`acrossRestart`)                          | both of the above                       |
| C13 | An empty catalogue fails the pass loudly rather than guessing                               | `mplus-season.service.spec.ts`          |

### 3.2 Live pass (§4.6, §5.5–§5.7)

| Id  | Rule                                                                                  | Covered by                    |
| --- | -------------------------------------------------------------------------------------- | ----------------------------- |
| L1  | The catalogue is loaded before the first `runs` request                                 | `mplus-season-transition.spec.ts` |
| L2  | Each region ingests its own current season; regions may differ on rollover day          | `mplus-season-transition.spec.ts` |
| L3  | A region with no opened season is skipped, not failed                                   | — (gap)                       |
| L4  | `mythicScore` = sum of best run per dungeon, and **never decreases**                    | `mplus-ingestion.spec.ts`, I12 |
| L5  | Cleanup: stale runs, then characters named by no surviving run                          | `mplus-ingestion.spec.ts`, I18 |
| L6  | No pruning after a pass that stopped early or had a failed page                         | `mplus-failures.spec.ts`      |
| L7  | `removeCharactersWithoutRuns` refuses a region with no runs at all                      | `mplus-failures.spec.ts`      |
| L8  | Anonymised roster members stay in the run and out of `mplus_characters`                 | I14, `mplus.mapper.spec.ts`   |
| L9  | 400 past the last page, and an empty page, both mean "end of board", not failure        | `mplus-ingestion.spec.ts`, `mplus-failures.spec.ts` |
| L10 | The pass yields to sweep/enrichment                                                     | `mplus-coordination.spec.ts` (before it starts), `mplus-yield.spec.ts` (between batches and regions) |
| L11 | A window that stays spent past `RAIDERIO_BUDGET_WAIT_MS` stops the region               | `mplus-failures.spec.ts`, `mplus-budget-wait.spec.ts` (the wait itself) |
| L12 | The pass no longer deletes superseded seasons                                           | `mplus-coordination.spec.ts`  |
| L13 | An empty 2xx body is a transient failure, not payload drift                             | `mplus-failures.spec.ts`      |
| L14 | An outage is recorded on Raider.io health, and forgotten when traffic succeeds          | `mplus-failures.spec.ts`, `mplus-coordination.spec.ts` |
| L15 | A region that cannot be refetched leaves its stored characters untouched                | `mplus-failures.spec.ts`      |
| L16 | The Raider.io key never reaches a health payload                                        | `mplus-coordination.spec.ts`  |

### 3.3 Season transition (§4.6.2)

| Id  | Rule                                                                              | Covered by                                |
| --- | ---------------------------------------------------------------------------------- | ----------------------------------------- |
| T1  | Retires a season **per region**, only once its successor opened there               | `mplus-season-transition.service.spec.ts`, `mplus-season-transition.spec.ts` |
| T2  | `MPLUS_PURGE_REQUIRE_ARCHIVE` holds a season until **that region** is archived      | both                                      |
| T3  | `unarchivable` counts as settled; `incomplete`/`partial` do not                     | `mplus-season-transition.service.spec.ts` |
| T4  | Characters are deleted before runs (I18 holds at every moment)                      | `mplus-season-transition.service.spec.ts` |
| T5  | Abstains while a pass is running; the rollover tick **waits** for it                | `mplus-season-transition.scheduler.spec.ts` |
| T6  | `MPLUS_PURGE_DRY_RUN` counts and deletes nothing                                    | `mplus-season-transition.service.spec.ts` |
| T7  | A purge is recorded in `mplus_season_transitions`                                   | `mplus-season-transition.spec.ts`         |
| T8  | An uncatalogued stored slug counts as superseded                                    | `mplus-season-transition.service.spec.ts` |
| T9  | Warns at boot when the interlock is on and the archive is off                       | — (gap)                                   |

### 3.4 Archive (§4.6.1)

| Id  | Rule                                                                                 | Covered by                |
| --- | -------------------------------------------------------------------------------------- | ------------------------- |
| A1  | Reads **each region's own board**, never `world`, to `MPLUS_ARCHIVE_PAGES` pages        | `mplus-archive.spec.ts`   |
| A2  | A season is owed while any configured region is not `complete`                          | `mplus-archive.mapper.spec.ts`, `mplus-archive.spec.ts` |
| A3  | A retry re-reads only the regions that failed                                           | `mplus-archive.spec.ts`   |
| A4  | A yield keeps the regions already read (`partial`), and writes nothing if none finished | `mplus-archive.spec.ts`   |
| A5  | A region is adopted from rows only when they are exactly a full read                    | `mplus-archive.spec.ts`   |
| A6  | A `world`-era marker (no `regions`) is re-read region by region                         | `mplus-archive.spec.ts`   |
| A7  | 404 marks the **season** unarchivable; an empty region board is `complete` with 0 runs  | `mplus-archive.spec.ts`   |
| A8  | The marker is written **after** the rows                                                | I19                       |
| A9  | Every affix on an archived run reaches `mplus_affixes`                                  | `mplus-archive.spec.ts`, I13 |
| A10 | Archived rows are never touched by the live pass                                        | `mplus-archive.spec.ts`   |
| A11 | Waits for both warm-ups; yields to every other job, including the PvP archive           | `mplus-archive.scheduler.spec.ts`, `mplus-archive.spec.ts`, `mplus-archive-scheduler.spec.ts` |
| A12 | Spends only its share of the minute (`RAIDERIO_ARCHIVE_SHARE`)                          | `mplus-archive.spec.ts` (charging only) |

### 3.5 Spec representation (§5.9)

| Id  | Rule                                                                      | Covered by                           |
| --- | --------------------------------------------------------------------------- | ------------------------------------ |
| R1  | One document per season × region × dungeon, plus `all`/`null` roll-ups       | `mplus-spec-representation.spec.ts`  |
| R2  | Per-dungeon runs and slots add up to their region's document                 | same                                 |
| R3  | Counted by roster slot; `percent` of classified, `rolePercent` within role   | `mplus-spec-representation.mapper.spec.ts` |
| R4  | Live recomputed each pass; archived written once and never recomputed        | `mplus-spec-representation.spec.ts`  |
| R5  | The live pass leaves a season archived everywhere alone                      | same                                 |
| R6  | Missing figures for an archived season are backfilled                        | same                                 |
| R7  | A pre-split document (no `dungeonId`) is replaced, and the old index dropped | same                                 |
| R8  | A region or dungeon with no runs gets no document                            | `mplus-spec-representation.mapper.spec.ts` |

### 3.6 Season cutoffs (§5.10)

| Id  | Rule                                                                   | Covered by                    |
| --- | ------------------------------------------------------------------------ | ----------------------------- |
| K1  | Stored per region on the season, with tiers and `p999`/`p990`             | `mplus-cutoffs.spec.ts`       |
| K2  | Alliance, horde and both together are kept apart                          | `mplus-cutoffs.mapper.spec.ts`, `mplus-cutoffs.spec.ts` |
| K3  | A tier the season did not award is left out, not stored null              | both                          |
| K4  | Live season re-read every pass; archived read once                        | `mplus-cutoffs.spec.ts`       |
| K5  | 404 → `missing`, never asked again                                        | same                          |
| K6  | Repeated failure → `failed`, then `unavailable` after 3 attempts          | same                          |
| K7  | A region left outstanding is picked up by the archive's backfill          | same                          |
| K8  | A cutoffs failure never fails the pass or the archive tick                | — (gap: only the happy path and recorded failures are asserted) |

### 3.7 Sync endpoint (§7)

`POST /mplus/characters/sync` — covered by `mplus-sync.spec.ts` (13 cases): never inserts,
merges `dungeonRuns` rather than replacing, recomputes score and coverage, refuses while a
pass is running (409), validates the body.

---

## 4. Configuration surface

Full table with defaults in §8 of `SKILLS.md`. The ones that change behaviour under test:

| Variable                             | Default    | In the harness | Effect                                     |
| ------------------------------------ | ---------- | -------------- | ------------------------------------------ |
| `MPLUS_ENABLED`                      | `false`    | `false`        | Scheduler only; services can still be driven |
| `MPLUS_ARCHIVE_ENABLED`              | `false`    | `false`        | Same                                        |
| `MPLUS_SEASON_REFRESH_ENABLED`       | `true`     | `false`        | Boot catalogue read + hourly season check   |
| `MPLUS_TRANSITION_ENABLED`           | `true`     | `false`        | Retirement interval + rollover tick         |
| `MPLUS_PURGE_REQUIRE_ARCHIVE`        | `true`     | default        | The interlock                               |
| `MPLUS_PURGE_DRY_RUN`                | **`false`**| default        | Unlike the PvP flag                         |
| `MPLUS_ARCHIVE_PAGES`                | `100`      | `3`            | Pages **per region**                        |
| `RAIDERIO_MAX_PAGES`                 | `1001`     | `5`            | Live pages per region                       |
| `RAIDERIO_PAGE_BATCH`                | `50`       | `5`            | Batch = how often priority/budget re-checked |
| `RAIDERIO_BUDGET_WAIT_MS`            | `60000`    | `0`            | 0 makes a spent budget observable at once   |
| `MPLUS_CATALOGUE_FIRST_EXPANSION`    | `6`        | `11`           | The fake world lists seasons under Midnight |
| `RAIDERIO_REGIONS`                   | 5 regions  | per file       | Region list for pass, archive and cutoffs   |

`RAIDER_IO_API_KEY` is required when either M+ job is enabled (boot fails otherwise), and
must never appear in a health payload or a log line.

---

## 5. Upstream facts a test must respect (§6.1, §9.9–§9.15)

Verified against the live API; dates are when each was last confirmed.

- **Page cap 1000**, 20 runs a page; `page=1001` answers **400**, which means "end of data".
- A region with fewer runs answers **200 with `rankings: []`** — also the end.
- `character.id` is Raider.io's, **not** Blizzard's; `realm.wowRealmId` is Blizzard's.
- Anonymised members: `id: 0`, realm `anonymous`, no `wowRealmId` (about 1 in 200).
- Rosters are **not always five** (2026-09-16); one sampled page had 399 members.
- Legion payloads carry `spec: {"name":"","slug":""}`; tournament realms carry
  `wowRealmId: null` (2026-09-16). Both parse to `null`.
- `static-data` is **per expansion**: 6–11 have seasons, 5 and 12 have none. 56 seasons, of
  which 21 are main; 74 dungeons, all covered by main seasons (2026-09-21).
- **Cutoffs coverage** (2026-09-23): `season-sl-3` onward for us/eu/kr/tw, `season-df-4`
  onward for cn. Older seasons answer **404**; cn before df-4 answers **500, consistently**.
  Tiers appear as titles were introduced, and a tier absent in a season is reported `null`.
- No rate-limit headers are exposed; a 300-request burst drew no 429 (2026-09-14).

---

## 6. Driving Mythic+ in a test

Harness rules in §10.2–§10.4 of `SKILLS.md`. The M+ specifics:

```ts
const world = new MplusWorld();
world.seed('us', 30, 500);                    // region, runs, top score, [season]
world.seasons = [...];                        // slug, starts/ends per region, expansionId, dungeons
world.unservedSeasons.add('season-x');        // runs answer 404 → unarchivable
world.seasonsWithoutCutoffs.add('season-x');  // cutoffs answer 404 → missing
world.cutoffBase['season-x'] = 3_800;         // per-season cutoff figures
run.affixes = [...];                          // per-run affix sets (weekly rotation)

const app = await bootTestApp(World.seed({ regions: ['us'], players: 10 }),
  { RAIDERIO_REGIONS: 'us,eu' }, undefined, undefined, world);

app.raiderIo.failWith('mythic-plus/runs', { status: 500, times: 1 });
app.raiderIo.beforeServe = (request) => { /* start a higher-priority job mid-page */ };
app.raiderIo.reset();                         // clears requests, failures and beforeServe
app.raiderIo.requests                         // { path, region, season, page, at }
await app.settle();                           // drains every scheduler seam (seams.ts)
```

Rules the harness enforces, and that a plan must design around:

- **One configuration per test file.** `ConfigModule` reads the environment once per module
  graph, and the graph is cached per file. A second `bootTestApp` with different env throws.
- **Test databases only.** `assertTestDatabase` refuses anything but `rankwarden_test_*`.
  Never point a test, or a live rehearsal, at the development database.
- `region=world` now answers **404** in the fake: a regression to the aggregate board fails.
- `expectInvariants(db)` runs the always-on set, Mythic+ included: I11 (typed), I12 (score
  sums), I13 (affixes), I14 (no anonymised), I17 (keys), I19 (markers), I20 (dungeons), plus
  I12–I14 again against the archive collections. **Three are opt-in** and must be called by
  name: `expectMplusRunsSelfContained` (I15), `expectMplusRosterKeysMirrorRoster` (I16) and
  `expectNoOrphanMplusCharacters` (I18).

---

## 7. Coverage added from the test plan, and what it found

The test plan (2026-09-25) closed the ten gaps this section used to list. Where each is now
pinned:

| Former gap                                   | Now covered by                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| 1. The five `POST /admin/mplus*` routes      | `mplus-admin.spec.ts` (M12.1–M12.5), `mplus-admin-production.spec.ts` (M12.6, the first production-guard integration test) |
| 2. `MplusSeasonScheduler`                    | `src/mplus-season/mplus-season.scheduler.spec.ts` (M1.3), `mplus-disabled.spec.ts` (M1.2) |
| 3. C4 walk on failure, C6 oldest stamp       | `mplus-catalogue.service.spec.ts` (unit), `mplus-catalogue.spec.ts` (M1.6, M1.7) |
| 4. K8, representation and cutoffs never fail the caller | `mplus-figures.spec.ts` (M7.1, M8.4)                          |
| 5. M+ health and readiness                   | `mplus-admin.spec.ts` (M12.7, M12.8), `mplus-infeasible.spec.ts`, `mplus-lifecycle.spec.ts` (M5.9) |
| 6. Archive share under contention            | `mplus-archive-share.spec.ts` (M4.10)                                    |
| 7. A region added later                      | `mplus-region-growth.spec.ts` (M6.2, M6.6)                               |
| 8. Transitions when rows reappear            | `mplus-season-resolution.spec.ts` (M5.6)                                 |
| 9. The budget wait                           | `mplus-budget-wait.spec.ts` (M4.7–M4.9)                                  |
| 10. Mid-pass yielding                        | `mplus-yield.spec.ts` (M4.5, M4.6)                                       |

Other new files: `raiderio-http.spec.ts` (the real `RaiderIoHttpService` against a listener,
M10.1–M10.6, M10.8), `mplus-payloads.spec.ts` (M2.x, M7.3, M10.7, M10.10),
`mplus-cleanup.spec.ts` (M3.x), `mplus-lifecycle.spec.ts` (M5.x), `mplus-archive-edges.spec.ts`
(M6.3–M6.7), `mplus-sync-edges.spec.ts` (M9.x), `mplus-restart.spec.ts` (M11.x),
`mplus-page-cap.spec.ts` (M2.5, the real 1,001-page cap), `mplus-first-pass.spec.ts` (M1.4),
`mplus-season-resolution.spec.ts` (M1.10–M1.12, M8.6), `mplus-cadence.spec.ts` and
`src/mplus/mplus-cadence.spec.ts` (F1), `mplus-invariants.spec.ts` (negative controls for
I21–I25), and M+ cases in `src/config/env.schema.spec.ts` (M1.5, M10.9).

**New harness pieces.** `FakeRaiderIo.failWith`/`corrupt` take matchers — a path fragment or
`page:`, `region:`, `season:`, `expansion:`, joined with `&` — and every request records its
`params`. `MplusWorld` has `addRun`, `removeRuns`, `member()`, `WORLD_DUNGEONS`, per-member
`specPlaceholder`, `wowRealmId: null` and `region`, and an opt-in `cacheRankings` for deep boards.
`holdActive(app, job)` / `releaseAllHolds()` in `support/hold.ts`, `CapturingLogger` in
`support/logger.ts`, and `RaiderIoServer` in `support/raiderio-server.ts`.

**New invariants.** Always on in `expectInvariants`: I21 (representation arithmetic), I23
(cutoff records well formed), I24 (region coherent, live and archive), I25 (archived rows owned
by their marker). Opt-in: I22 `expectMplusStoredMatchesServed(db, world, { season, region,
maxPages, before? })` — stored data against what the fake served — with
`snapshotMplusCharacters` for `before`.

**Every new safeguard was proven by a break**: 22 deliberate breaks, each caught by the case
written for it.

### 7.1 Confirmed defects

Each is pinned twice: a "today" case that passes and describes what happens, and a "desired"
case marked `it.fails`. When a fix lands, both flip: remove `.fails`, delete or rewrite the
"today" case.

| Id | Defect                                                                                   | Cases                                   |
| -- | ---------------------------------------------------------------------------------------- | --------------------------------------- |
| F1 | A full pass (358s at the defaults) outlasts the 300s enrichment interval; an enrichment start mid-pass ends it for every later region with no resume, a tick landing during enrichment waits a whole interval, and readiness still calls the cadence feasible | `src/mplus/mplus-cadence.spec.ts` (M4.1, M4.4), `mplus-yield.spec.ts` (M4.2), `mplus-cadence.spec.ts` (M4.3) |
| F2 | A populated region answering an empty first page is reported clean, its runs are pruned, and its characters are left named by no run; stage 1 of the prune has no guard of its own | `mplus-cleanup.spec.ts` (M3.1, M3.2)    |
| F3 | A live season's cutoffs are given up on for good: one 404 turns even an `ok` region into `missing`, three failing passes into `unavailable`, and neither is read again | `mplus-figures.spec.ts` (M8.1, M8.2)    |
| F4 | A 404 after some regions were read writes `unarchivable` with `regions: {}`: their rows are owned by nothing, and the transition then treats the season as held | `mplus-region-growth.spec.ts` (M6.1)    |
| F5 | Under the default interlock, a leftover season the catalogue does not list is blocked and warned about on every run, and never retired | `mplus-region-growth.spec.ts` (M5.5)    |
| F6 | One season no walk re-stamps keeps the catalogue due, so every `refreshIfDue` is a full walk | `mplus-catalogue.spec.ts` (M1.8)        |
| F7 | While a season is partly archived, the live pass rewrites its representation from the regions it read and deletes the others' documents | `mplus-figures.spec.ts` (M7.2)          |

### 7.2 Pinned as they are, for a decision

Behaviour a case now records without judging it; each is the owner's call.

- **M1.11** — a current season whose start moves into the future is announced as a rollover
  *backwards* (mn-2 → mn-1).
- **M2.6** — a run that slides above the read cursor mid-pass is pruned while still ranked, and
  its members who appear in no other run are deleted with it until the next pass.
- **M2.10** — a roster member from another region is filed under the board's region but keyed
  under its own (I17 and I24 both fail). X5 decides whether this happens live.
- **M3.10** — `mergedCharacters` counts every character currently holding a dungeon outside
  the window, on every pass, not only those newly merged.
- **M6.3** — with a region dropped from the configuration, representation treats the season as
  archived (by regions owed) while the cutoffs do not (by `status === 'complete'`).
- **M6.4** — a season with no runs anywhere has its representation recomputed on every tick.
- **M6.7** — raising `MPLUS_ARCHIVE_PAGES` never deepens a completed season.
- **M9.1–M9.3** — sync is case-sensitive on the realm slug, not Unicode-normalised, and accepts
  dungeons the season does not list.
- **M11.3** — the Raider.io budget window is forgotten on restart.
- The archive logs a cutoffs failure as "Could not record Mythic+ spec representation" (it
  reuses the representation wrapper).
- The client keeps the access key out of the URLs it builds, but for messages got builds itself
  it relies on `DependencyHealth.redact`, which works because both read one config.

### 7.3 Still open

The live cross-check (X1–X8) has not been run: it needs the real key, a throwaway database and,
for X7, enrichment running against real Blizzard. X5 (another region's character on a board)
and X8 (do cutoffs 404 for a season that has just opened?) are the cheap ones, and each decides
something above.

---

## 8. Live verification, when a fake is not enough

Payload traps (§9.14) were only ever found by reading real data. When a plan needs that:

- Point `MONGODB_DB` at a **throwaway** database (`rankwarden_check_*`), assert the name in
  the script before writing, and drop it in a `finally`.
- Disable every scheduler through `process.env` and drive the services directly.
- Never write to the development database, and never print the API key.

Figures from the last real runs, useful as sanity checks:

| Check                                    | Result                                                        |
| ---------------------------------------- | ------------------------------------------------------------- |
| Catalogue (2026-09-21)                   | 6 expansions, 21 main seasons, 74 dungeons, 0 orphans          |
| Archive of `season-tww-3` (2026-09-21)   | 5 regions × 100 pages = 10,000 runs, 500 requests, 69s         |
| Representation of the same               | 54 documents; per-dungeon runs sum to 10,000; 40 specs         |
| Cutoffs, all seasons × regions (2026-09-23) | 105 reads in 45s: 50 `ok`, 50 `missing`, 5 cn `failed`      |

`live-archive-one-season.mjs` in the repo root archives one season into the configured
database and prints a cross-reference summary; it is untracked scaffolding, not a fixture.

---

## 9. Standing constraints

- All six checks must pass: `typecheck`, `lint`, `format`, `build`, `test`, `test:int`.
- Prove a new safeguard by breaking the code, watching the test fail, and restoring it.
- Do not commit or push unless asked.
- `MPLUS-AGENT-BRIEF.md` is the original onboarding brief, kept for history. Its open
  questions are settled and its file layout predates `src/mplus-season/`,
  `src/mplus-archive/` and `src/mplus-representation/`. Prefer `SKILLS.md` and this file.
