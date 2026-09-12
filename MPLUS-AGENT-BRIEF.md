# Onboarding brief — Mythic+ ingestion (Raider.io)

You are adding Mythic+ data to **Rankwarden**, a NestJS (ESM, TypeScript) service that
ingests World of Warcraft PvP leaderboards from the Blizzard Game Data API into MongoDB.
Your work adds a **second upstream**: top M+ runs from the **Raider.io API**, stored
alongside the existing data and fetched **while the Blizzard jobs keep running**.

The owner will append the Raider.io specifics — endpoints, payload shape, what to store —
below this brief. This half is about the codebase: where things go, how requests are
budgeted across jobs, how tests work, and what the project expects of a change.

Read this whole file before writing code. Then read `SKILLS.md`.

---

## 1. Orientation — read in this order

| Read                                         | For                                                                                            |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `SKILLS.md`                                  | **The reference.** Architecture, data model, domain traps, testing. All of it.                 |
| `SKILLS.md` §4 and §4.0                      | Job priority and the shared hourly budget — the part your work touches most.                   |
| `SKILLS.md` §9 "Domain rules and traps"      | Rules found by observing wrong data. Cheap to reintroduce, expensive to spot.                  |
| `SKILLS.md` §5.1                             | The `characters` document, including `characterType` — M+ characters live here.                |
| `SKILLS.md` §10                              | The two test projects and the integration harness rules.                                       |
| `SKILLS.md` §11 "Extending"                  | The house patterns for adding a job, a field, an index.                                        |
| `src/archive/`                               | The closest model for what you are building: own module, scheduler, repository, budget checks. |
| `src/blizzard/http/blizzard-http.service.ts` | How an upstream client is wrapped: retries, per-attempt accounting, health, error classes.     |
| `.env.example`                               | Every knob, with comments. Yours go here too.                                                  |

`SKILLS.md` is the living document. **Keep it that way** — a change that is not in it will be
re-discovered the hard way by the next agent. There is no `CLAUDE.md`; `SKILLS.md` is it.

---

## 2. Project structure, and where M+ goes

```
src/
  main.ts                bootstrap
  app.module.ts          composition root — register your module here
  config/env.schema.ts   zod env schema; the ONLY place configuration is declared
  common/
    ingestion-coordinator.service.ts     who may run now (priority, warm-up gate)
    quota/quota-budget.service.ts        how much each job may spend this hour
    logging/run-context.ts               AsyncLocalStorage run ids + RunKind
    pending-work.ts                      makes fire-and-forget work awaitable
    health/dependency-health.service.ts  per-upstream health for readiness
    utils/rate-limiter.ts                token bucket (burst pacing)
    utils/concurrency.ts                 bounded parallel map
  blizzard/              upstream client: http/, auth/, schemas/, pvp.api.ts, profile.api.ts
  leaderboard/           the PvP sweep + character and rating repositories
  profile/               PvP profile enrichment (you do NOT need this — see §4)
  archive/               finished seasons; the best template to copy
  season/ representation/ sync/ health/ admin/
```

Follow the existing shape rather than inventing one:

| Add                                                                                             | Mirroring                                                                                                      |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/raiderio/raiderio.module.ts`                                                               | `src/blizzard/blizzard.module.ts`                                                                              |
| `src/raiderio/http/raiderio-http.service.ts`                                                    | `blizzard/http/blizzard-http.service.ts` — one shared `got` instance, retries, accounting, health, typed error |
| `src/raiderio/schemas/*.schema.ts`                                                              | `blizzard/schemas/*` — zod per payload, validated at the boundary                                              |
| `src/raiderio/*.api.ts`                                                                         | `pvp.api.ts` — typed methods returning parsed payloads                                                         |
| `src/mplus/mplus.module.ts` + `.service.ts` + `.scheduler.ts` + `*.repository.ts` + `entities/` | `src/archive/*`                                                                                                |
| env vars in `src/config/env.schema.ts`                                                          | the `ARCHIVE_*` / `QUOTA_*` blocks                                                                             |
| a dev-only trigger in `src/admin/admin.controller.ts`                                           | `POST /admin/archive` and `archive-rewards`                                                                    |
| readiness signals in `src/health/health.controller.ts`                                          | the `quota` and `enrichment` blocks                                                                            |

Conventions that are not negotiable:

- **Relative imports carry the `.js` extension** (`module: nodenext`). Missing it fails at
  runtime, not at compile time.
- **All configuration is a zod field** in `env.schema.ts`, with a default and a comment saying
  what it is for, plus a line in `.env.example`. Nothing reads `process.env` directly.
  Cross-field constraints go in the `superRefine` at the bottom of that file, so a nonsensical
  combination fails at boot naming the variable at fault.
- **Schedulers** follow `ArchiveScheduler`: `SchedulerRegistry.addInterval` in
  `onApplicationBootstrap`, `deleteInterval` in `onModuleDestroy`, a `running` re-entry guard,
  work launched through `PendingWork`, and a `whenSettled()` seam. Add the new scheduler to
  `test/support/seams.ts` — `settle()` must cover it or tests race it.
- **An `*_ENABLED` flag** for every background job, so it can be switched off in tests and in
  production.
- Comments explain **why**, not what. Match the density of the file you are in.

---

## 3. Request limiting — the part to get right

M+ fetching runs **alongside** the PvP jobs, so this is where a mistake is most expensive.
There are three separate mechanisms today. Learn all three before adding a fourth.

### 3.1 What exists

1. **`RateLimiter`** (`common/utils/rate-limiter.ts`) — a token bucket per job, pacing
   requests per _second_ so a burst does not trip an upstream. Configured by
   `*_REQUESTS_PER_SECOND`.
2. **`QuotaBudget`** (`common/quota/quota-budget.service.ts`) — one rolling-hour budget for
   **Blizzard**, shared by every job. Blizzard allows 36,000 requests an hour across the whole
   client. Requests are counted in one-minute buckets over the last 60 minutes and charged
   **per attempt, retries included**, by the HTTP client's `beforeRequest` hook — Blizzard
   counts retries, so the budget must too. Each request is attributed to the job that made it
   via `currentRunKind()` (AsyncLocalStorage), so no call site passes a label. Jobs draw from
   shares in priority order: the sweep is never throttled and keeps a reserve (~340/h actual),
   enrichment plans at most `limit / QUOTA_ENRICHMENT_HEADROOM` (12,000/h), the archive gets
   the remainder (~19,400/h), and only `limit x QUOTA_UTILISATION` (32,400) is ever planned
   against. Jobs ask `budget.allowance('archive')` before spending and stop at zero.
3. **`IngestionCoordinator`** (`common/ingestion-coordinator.service.ts`) — decides who may run
   _now_. The sweep never waits; enrichment yields to it; the archive yields to both and does
   not start until `warmedUp$` fires. It is separate from the budget because the two fail
   separately: a job can be allowed to run and still have nothing left to spend.

Read the header comment on `QuotaBudget` before designing anything here. It records why the
per-job limiters were replaced: each was sized as if it owned the whole quota (the archive
alone was allowed 10/s, which _is_ the hourly cap), nothing added them up, and the three jobs
together came to roughly 41,000 requests an hour against a 36,000 limit.

### 3.2 Rules for the Raider.io limiter

- **Never charge a Raider.io request to `QuotaBudget`.** It models Blizzard's cap. Charging
  foreign requests to it would throttle enrichment and the archive for no reason, and make
  `/health/ready` lie about both.
- **Never give the M+ job a bare `RateLimiter` and call it done.** That is exactly the mistake
  §4.0 of `SKILLS.md` records. Per-second pacing does not bound a per-minute or per-hour
  allowance, and nothing would add the M+ job up against itself across runs.
- **Give Raider.io its own accounted budget**, with the same properties that make the Blizzard
  one trustworthy: a rolling window, charged per attempt including retries, at the HTTP client
  seam rather than at call sites, attributed to the run in progress, readable from memory for
  readiness, and configurable with a boot-time sanity check. The rolling-window counter in
  `QuotaBudget` is worth generalising (a provider-keyed budget, or a small shared window class
  both build on) rather than copy-pasting. Whichever you choose, say which and why in
  `SKILLS.md`.
- **Add a `RunKind`** for M+ in `common/logging/run-context.ts` (`'mplus'`, say) and wrap the
  job in `withRunId('mplus', ...)`. Attribution and log correlation both hang off it. The
  Blizzard `quotaConsumerFor()` maps unknown kinds to `other`, so check that adding a kind does
  not silently make M+ requests look like Blizzard's `other` bucket anywhere.
- **Confirm the real Raider.io limits from their documentation and response headers** rather
  than assuming. Honour `429` and `Retry-After`, and treat the documented limit as the budget's
  ceiling with a utilisation margin, as the Blizzard one does. Record the numbers you found,
  and where you found them, in `SKILLS.md`.
- **Decide and document the interaction with the existing jobs.** The two upstreams have
  independent quotas, so M+ need not yield to a sweep for _request_ reasons — but it shares
  MongoDB, the process, and (if you store characters in `characters`) the same collection the
  sweep rewrites and cleans up. Make that an explicit decision through `IngestionCoordinator`,
  not an accident. Note that `warmedUp$` fires after the first sweep _and_ first enrichment
  pass; if M+ is gated on it, `markEnrichmentDisabled()` is what releases it when enrichment is
  off.
- **Register Raider.io in `DependencyHealth`** as a **soft** dependency: readiness reports
  `degraded` (HTTP 200) when an upstream is failing, and only Mongo failing gives a 503. Never
  fail liveness on an upstream.
- **Readiness must report the new budget** the way `quota` is reported — from memory, with no
  database I/O in the readiness path. Include whatever "can this keep up?" signal makes sense
  for M+; `EnrichmentOutlook` is the precedent for a job publishing its own verdict for the
  health endpoint to read.
- No credential, API key or connection string may appear in any health payload or log.
  `common/health/redact.ts` and `hostOf()` exist for that.

---

## 4. The data side you inherit

`characters` is one document per character per season+region and already carries
**`characterType: 'PvP' | 'M+'`** (`src/leaderboard/entities/character.entity.ts`). It was
added for you. What it guarantees:

- The PvP sweep stamps `'PvP'` **on insert only** (`$setOnInsert`), so it never reclassifies a
  document another source created.
- Profile enrichment only ever selects `characterType: 'PvP'`, through a single `ENRICHABLE`
  filter in `src/leaderboard/character.repository.ts`. Selection, the demand count, the
  population and the stalest-refresh age all use it. **M+ characters are therefore never
  enriched and never counted as enrichment demand** — the point being that their data arrives
  complete in one Raider.io response.
- The two enrichment indexes are **led by `characterType`** for a reason: a character that is
  never enriched never gets a fetch timestamp, and an absent timestamp sorts before every date.
  Without the prefix, every enrichment run would walk past all M+ characters before reaching
  one it can use. If you add queries over `characters`, watch for the same trap.
- Invariant **I11** (`test/support/invariants.ts`) asserts every character carries a type.
  Whatever writes M+ characters must set it.

**Before storing M+ characters in `characters`, audit the paths that delete or rewrite
character documents** and confirm each behaves correctly for an M+ document. At minimum:
`removeUnranked` (deletes `{ brackets: {} }`), the excluded-bracket purge, `pruneBracket` /
`removeRetiredBrackets`, `RatingRepository.removeOrphans`, and the season purge in
`src/season/season-transition.service.ts` (deletes by `seasonId`, and M+ season numbering
differs from PvP). `SKILLS.md` §9.8 lists the cleanup order and why it is that order. These are
no-ops for M+ today only because no M+ document exists yet. Raise what you find before working
around it — the identity key is `seasonId + region + characterId`, and whether an M+ record can
collide with a PvP one for the same character is a design question for the owner, not something
to guess.

---

## 5. Tests

Two Vitest projects, because the layers have different prerequisites:

| Command            | Project       | Covers                                          | Needs   |
| ------------------ | ------------- | ----------------------------------------------- | ------- |
| `npm test`         | `unit`        | `src/**/*.spec.ts` — pure functions, mocked DI  | nothing |
| `npm run test:int` | `integration` | `test/**/*.spec.ts` — real Mongo, fake upstream | Docker  |
| `npm run test:all` | both          |                                                 | Docker  |

`npm run db:up` starts `mongo:8` (and mongo-express on 8081). Both projects must be green
before you hand anything over.

The integration harness (`test/support/`) has rules that are load-bearing:

- **The fake sits at the HTTP seam, not at the API class.** `FakeBlizzard` replaces
  `BlizzardHttpService` and serves raw JSON out of a mutable `World`, so the real zod schemas
  parse the fake payloads and the payload traps stay inside the test. Build a `FakeRaiderIo`
  the same way, and reproduce the upstream's real quirks in it deliberately (a field present
  only on the first entry, a null where you expected an absence — whatever you find). Wire it
  in `test/support/app.ts` beside the existing seams, and note the fake must also charge your
  new budget and record health, or every test runs against a budget that never fills and
  readiness reports `unknown` forever.
- **One configuration per test file.** `ConfigModule.forRoot()` reads the environment when
  `app.module.ts` is first imported and ESM caches that module per file, so a second
  `bootTestApp` with different settings would silently reuse the first. The harness throws
  instead; put a scenario needing different configuration in its own file.
- **Never the development database.** Every test database is `rankwarden_test_<file>` and
  `assertTestDatabase` refuses anything else. `test/setup/integration-env.ts` also points the
  Blizzard host at a dead port so a missed seam fails locally instead of spending real quota.
  Do the same for the Raider.io base URL.
- **`whenSettled()` seams** make un-awaitable scheduler work awaitable; `TestApp.settle()`
  drains them and `close()` drains before closing.
- **Invariants** (`expectInvariants`) run at the end of integration scenarios and catch far
  more than per-case assertions. Extend them for M+ rather than only asserting locally.

Two practices worth copying from recent work:

- **Prove a test can fail.** For anything subtle — a limiter, a retry rule, an index that keeps
  a scan small — temporarily break the code, watch the test fail, then restore the file
  **byte-exact** (`git diff` empty afterwards). On Windows, do not round-trip a file through
  Windows PowerShell 5.1 `Get-Content`/`Set-Content`: it mangles non-ASCII characters. Use
  `git stash`, `git checkout --`, or a byte-level copy.
- **Check real behaviour against the real API** with a throwaway read-only script before
  trusting an assumption about a payload (`scripts/live-crosscheck.mjs` is the precedent).
  Record what you observed in a comment or in `SKILLS.md` — several rules in §9 exist only
  because someone did that.

---

## 6. Workflow for a change

1. **Before coding**: read the relevant `SKILLS.md` sections, then say what you plan to add and
   where. Flag anything that changes existing behaviour, and anything the owner has to decide
   (see §4 and §8).
2. **Implement** following the module shape in §2.
3. **Verify — all six, all green:**
   ```
   npm run typecheck
   npm run lint
   npx prettier --check "src/**/*.ts" "test/**/*.ts" SKILLS.md
   npm run build
   npm test
   npm run test:int
   ```
4. **Update documentation and configuration in the same change**: `SKILLS.md` (module map, job
   table, data model, config table, endpoints, testing notes), `.env.example`, and the owner's
   local `.env` when a new variable has no usable default.
5. **Do not commit or push unless asked.** The owner reviews the working tree, commits, and
   merges `develop` into `main` themselves. The working branch is `develop`.
6. **Report honestly**: what you changed, what you verified and how, what you chose and why,
   what you did not do. If a test fails, say so with the output.

Running the app for a real check: `npm run build`, then
`node --env-file-if-exists=.env dist/main.js`. **`npx tsx` does not work** — it does not emit
decorator metadata, so Nest DI fails. Dev-only triggers at `POST /admin/*` (404 when
`NODE_ENV=production`) are the controlled way to drive one cycle of a job by hand; shrinking
intervals instead makes every job race every other one.

---

## 7. Things that will look like improvements and are not

- **A private rate limiter for the new job, unaccounted anywhere.** See §3.2.
- **Reusing `QuotaBudget` for Raider.io** because it is already injected everywhere. See §3.2.
- **Enriching M+ characters** "for consistency". Their data arrives in one response, the quota
  is the scarce resource, and §4 is built to keep them out of that queue.
- **Hardcoding a spec or class list.** Brackets and specs are deliberately opaque strings so a
  new spec needs no code change; where a mapping is unavoidable it is resolved from the API and
  cached (see `src/archive/season-rewards.ts`).
- **Inferring state from stored rows** when a durable marker can record it — see why
  `archive_brackets` exists (`SKILLS.md` §5.4), and the season-rewards failure record.
- **Failing readiness on an upstream outage.** It would have an orchestrator restart-loop the
  service through an incident it cannot fix.
- **Swallowing a payload that does not match its schema.** Classify it: permanent (shape drift)
  versus transient (a 5xx, a timeout, an empty body). `SKILLS.md` §6 and §4.2 show the
  distinction and what each one costs.

---

## 8. Open questions to settle with the owner before writing storage code

1. Does an M+ character share the `characters` document with its PvP record, or is the identity
   key extended? M+ and PvP number their seasons separately.
2. Which collections hold the runs themselves, and do they reference `characters` or stay
   self-contained the way `archive_entries` does (and for the same reason)?
3. What the M+ job's cadence and freshness target are — that is what sizes its budget share,
   the way `PROFILE_SPECS_TTL_MS` sizes enrichment's.
4. Whether M+ must yield to the PvP sweep for database reasons, given it writes into the same
   collection.

---

_The Raider.io integration details follow below, from the owner._
