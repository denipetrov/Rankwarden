# Rankwarden

NestJS service that ingests World of Warcraft PvP leaderboards from the Blizzard
Game Data API and (as of the next iteration) persists them to MongoDB.

## Flow

1. **Boot** — env is validated with zod, MongoDB connects, indexes are ensured, and
   the Blizzard OAuth credentials are verified.
2. **Season resolution** — `GET /data/wow/pvp-season/index` per region; the active season
   id and its start date are cached in memory (`SeasonService`). A dedicated job
   re-checks this every `SEASON_REFRESH_INTERVAL_MS` (1 day) so a rollover is caught at
   runtime rather than only on restart, independently of whether sweeps are running.
3. **Sweep** — for every `region × bracket` pair the leaderboard is fetched, validated
   with zod, and merged into the character documents. Brackets a character no longer
   ranks in are unset; characters left in no bracket at all are deleted.
4. **Repeat** — the sweep re-runs every `INGEST_INTERVAL_MS`. Overlapping sweeps are
   skipped rather than queued.
5. **Enrichment** — a separate background pass fills in race, class, spec and hero
   talent tree per character. Characters a sweep has just discovered are enriched
   immediately; everyone else is refreshed once their profile passes `PROFILE_TTL_MS`
   (1 day).

Regions: `us, eu, kr, tw`. Brackets come from Blizzard's per-season leaderboard index
rather than a hardcoded list, so new specialisations are picked up on their own. Of the
85 it publishes, **83 are ingested**: `2v2`, `3v3`, `rbg`, and a
`shuffle-<class>-<spec>` / `blitz-<class>-<spec>` ladder per specialisation.

`shuffle-overall` and `blitz-overall` are **deliberately skipped**. Solo Shuffle and
Blitz are rated per specialisation, and the aggregate board does not track a character's
best spec — one character sits at rank 1 in `shuffle-mage-fire` with 2688 while their
overall reads 2454, which is their _frost_ rating. Across the dataset, 748 of 11,105
characters had a spec rating higher than their overall, by as much as 2006 points.
Storing it would mean holding a rating that contradicts the per-spec data. The exclusion
lives in `EXCLUDED_BRACKETS`, and documents carrying aggregate data from earlier builds
are purged at startup.

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
  season/                     in-memory active season per region, refreshed daily
  leaderboard/                sweep orchestration, mapper, character repository, scheduler
  database/                   MongoClient lifecycle
  health/                     GET /health — season snapshot + sweep state
  archive/                    finished seasons, fetched once and kept separately
  representation/             daily spec-representation snapshots
  sync/                       POST /characters/sync — push a record in from the API
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
    '2v2':               { rank: 897,  rating: 1821, played: 51, won: 30, lost: 21, fetchedAt: … },
    '3v3':               { rank: 1282, rating: 1668, played: 47, won: 23, lost: 24, fetchedAt: … },
    'shuffle-mage-fire': { rank: 1,    rating: 2688, played: 88, won: 51, lost: 37, fetchedAt: … },
  },
  // mirror of the ratings above — the only searchable per-bracket field
  ratings: { '2v2': 1821, '3v3': 1668, 'shuffle-mage-fire': 2688 },
  // strongest rating per spec-split family, recomputed at the end of each sweep
  best: { shuffle: { bracket: 'shuffle-mage-fire', rating: 2688 } },
  updatedAt: …,

  // filled in by the enrichment pass, not the sweep
  profile: {
    race:           { id: 10, name: 'Blood Elf' },
    class:          { id: 2,  name: 'Paladin' },
    spec:           { id: 65, name: 'Holy' },
    heroTalentTree: { id: 49, name: 'Lightsmith' },   // null below hero-talent level
    talentLoadouts: [                                 // active build per spec
      { spec: { id: 65, name: 'Holy' },        talentLoadoutCode: 'CEEAzbn3egS…' },
      { spec: { id: 70, name: 'Retribution' }, talentLoadoutCode: 'CYEAzbn3egS…' },
    ],
    realmName: 'Demon Soul',                          // the sweep only knows the slug
    title: 'Galactic Gladiator {name}',               // null when none is equipped
    level: 90, gender: 'FEMALE',
    guild: { id: 91360489, name: 'veow' },
    averageItemLevel: 278, equippedItemLevel: 278,
    lastLoginAt: …,
  },
  profileStatus: 'ok',        // 'missing' once Blizzard 404s the character
  profileFetchedAt: …,        // summary half — absent means never fetched
  specsFetchedAt: …,          // spec half, refreshed on its own shorter TTL
}
```

### Indexing 85 brackets with one index

One index per bracket is impossible — MongoDB caps a collection at 64. Instead, `rating`
(the only field ladders are ordered by) is mirrored into a flat `ratings` map, covered by
a single **compound wildcard index**:

```js
{ seasonId: 1, region: 1, 'ratings.$**': 1 }
```

Measured on 138k characters, every bracket — core or per-spec — pages at **50 keys / 50
docs examined, index-ordered, no blocking sort**, from one 2.3MB index. The five
per-bracket indexes it replaced cost 1.8MB between them and covered five brackets.

The bulky `brackets` payload is never indexed: it is read, not searched.

Full index set: unique `seasonId + region + characterId` identity, `characterName +
realmSlug` lookup, `profileFetchedAt` for enrichment staleness, and `bracket_ratings`.
That is four, whatever the bracket count. Superseded `bracket_*_rank` indexes are dropped
automatically at startup.

### The all-classes / all-specs board

Solo Shuffle and Blitz are rated per specialisation, so a character holds one rating per
spec they play — and a board covering every class and spec must list them once per spec,
not once per character. That is a different shape from `characters` (one row per rating,
not one document per player), so it gets its own collections:

```
2v2_ratings   3v3_ratings   rbg_ratings   shuffle_ratings   blitz_ratings
{ seasonId, region, bracket, characterId, rating, fetchedAt }
```

One collection per ladder family. 2v2, 3v3 and rbg give a character a single row
each; shuffle and blitz give them one row per spec they have played.

The board is a plain sorted range scan, with display data joined afterwards by
`characterId`:

```js
db.shuffle_ratings.find({ seasonId: 42, region: 'us' }).sort({ rating: -1 }).limit(50);
```

Measured on 131,545 shuffle rows: **50 keys / 50 docs examined, index-ordered**, and 12ms
including a `$lookup` into `characters` for names, realms and class. Paginate with a
rating cursor (`rating: { $lt: lastSeen }`) — that stays at 50 keys at any depth, whereas
`skip: 5000` examined 5,050.

Indexes per collection: `seasonId + region + rating` (the board), a unique
`seasonId + region + bracket + characterId` (the upsert key), and `characterId` for
"every rating this character holds" on a character page.

Rows are written alongside the character documents during the sweep and cleaned three
ways at the end of it, because each covers a case the others cannot reach:

| Cleanup                                           | Removes                                        | Case it covers                                                               |
| ------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| `pruneBracket` (per bracket, by `fetchedAt`)      | rows the sweep did not refresh                 | the character left that ladder                                               |
| `removeOrphans` (reconciled against `characters`) | rows whose character no longer exists          | the character was deleted outright, or a row survived pruning some other way |
| `removeRetiredBrackets`                           | rows for brackets Blizzard no longer publishes | a specialisation ladder disappears, so no sweep job ever visits it again     |

Only the first runs per bracket; the other two run once per region, after the unranked
characters have been deleted, so their rows are already orphans by then.
`removeRetiredBrackets` refuses to act when a region's sweep produced no brackets at all
— that means the sweep failed, not that every ladder retired, and acting on it would
empty the region.

### Querying a ladder

```js
db.characters
  .find({ seasonId: 42, region: 'eu', 'ratings.3v3': { $gt: 0 } })
  .sort({ 'ratings.3v3': -1 })
  .limit(50);
```

The `$gt: 0` predicate is **required**, not decoration. Characters who do not play a
bracket have no key for it, missing fields index as `null`, and `null` sorts before every
number — so omitting it silently returns players from other brackets at the top of the
ladder. Use `$gt: 0` rather than `$exists: true`: it bounds the index scan, where
`$exists` scans the whole null region (measured 11,032 keys examined versus 50).

For deep pages prefer a rating cursor (`rating < lastSeenRating`) over `skip`, which
costs one key per skipped row.

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

**The two endpoints age at different rates**, so each carries its own timestamp and its
own TTL, and a pass fetches only the halves that are actually due:

| Half            | Fields                                              | TTL                               | Why             |
| --------------- | --------------------------------------------------- | --------------------------------- | --------------- |
| Summary         | race, class, realm, title, guild, level, item level | `PROFILE_SUMMARY_TTL_MS` (7 days) | Changes rarely  |
| Specializations | spec, hero talent tree                              | `PROFILE_SPECS_TTL_MS` (1 day)    | Follows respecs |

A character already carrying a fresh summary costs **one** request on refresh instead of
two. Writes are field-level (`profile.race`, `profile.spec`, …) precisely so the two
halves can be written independently without clobbering each other.

Selection is `specsFetchedAt` ascending. Specs have the shorter TTL, so anything due for
a summary refresh is necessarily due for specs too, which makes that one timestamp
sufficient to pace the queue; and the field is absent until first enriched, so
never-seen characters always sort ahead of the refresh queue. A finished sweep also
fires a new-characters-only pass immediately, so ladder newcomers do not wait out the
interval.

A 404 is recorded as `profileStatus: 'missing'` rather than retried, because renames and
transfers are routine.

**Talent loadouts are stored per spec**: every specialisation a character has built
carries its own `is_active` loadout, so both the importable code and the hero talent tree
stay paired with the spec they belong to. The one currently being played is the entry
whose `spec.id` equals `profile.spec.id`.

That pairing is not just for deep-linking. `profile.heroTalentTree` is only the _active_
spec's tree, so anything reasoning about a character on another spec's ladder — the
representation snapshots especially — must read the tree from the matching loadout
instead. Specs with no active loadout are omitted; one whose loadout has no importable
code is kept, because its hero tree is still worth knowing.

### Enrichment yields to the sweep

Both processes write the same documents and draw on the same hourly quota, so
[`IngestionCoordinator`](src/common/ingestion-coordinator.service.ts) keeps them apart:
a sweep claims exclusivity for its duration, enrichment refuses to start while one is
active, and an in-flight pass stops between characters if a sweep begins. The sweep
never waits — it is what keeps rankings current.

The sweep-completed event is emitted _after_ the coordinator releases; emitting it from
inside meant the follow-up pass saw a sweep still running and deferred itself.

## Spec representation ("flavour of the month")

One snapshot per UTC day per region, family and rating cutoff
(`REPRESENTATION_MIN_RATINGS`, default `1500,1800,2100,2300,2700`), in
`spec_representation`, for as long as a season runs. Each row is a complete picture of who was playing what:

```js
{ date: 2026-09-04T00:00:00Z, seasonId: 42, region: 'us', family: 'shuffle', minRating: 1800,
  total: 8248, classified: 8248,
  specs: [
    { class: 'priest', spec: 'holy', count: 825, share: 0.1000,
      heroTalentsClassified: 7,
      heroTalents: [ { id: 42, name: 'Oracle', count: 7, share: 1.0 } ] },
    { class: 'warrior', spec: 'arms', count: 535, share: 0.0649,
      heroTalentsClassified: 3,
      heroTalents: [ { id: 33, name: 'Slayer',         count: 2, share: 0.6667 },
                     { id: 34, name: 'Mountain Thane', count: 1, share: 0.3333 } ] }, … ] }
```

Three levels of detail: **class → spec → hero talent tree**. `share` on a spec is a
fraction of the snapshot's `classified`; `share` on a hero talent is a fraction of that
spec's `heroTalentsClassified`, so each spec's trees sum to 1 independently.

`class` and `spec` are Blizzard's own slugs, so `Death Knight` and `deathknight-blood`
resolve to the same key whichever family produced them. `share` is a fraction of
`classified` and sums to 1. The visualisation's query — one series over time — is
covered by a dedicated index and returns in ~1ms.

### Coverage is not uniform, and the snapshot says so

Where the spec comes from differs by family, and this materially affects how much the
numbers can be trusted:

| Family         | Spec comes from                        | Coverage                              |
| -------------- | -------------------------------------- | ------------------------------------- |
| shuffle, blitz | the bracket name (`shuffle-mage-fire`) | **100%**, immediately                 |
| 2v2, 3v3, rbg  | the enriched `profile.spec`            | only as far as enrichment has reached |

That is why every row carries `classified` alongside `total`. A snapshot where
`classified` is far below `total` is a sample, not a census, and the front end should say
so rather than draw it as fact. Measured on a fresh database: shuffle and blitz were at
100%, while us 3v3 @1800 classified 37 of 925 characters (4%) because enrichment had
barely started.

**2v2/3v3/rbg spec representation and hero talent representation everywhere are only
meaningful once profile enrichment has covered the ladder.** At the default batch size
that is roughly two days for a full pass; raise `PROFILE_BATCH_SIZE` to shorten it.

A full snapshot takes about 4.7 seconds across 4 regions x 5 families x 5 cutoffs.

### Scheduling

A tick runs every `REPRESENTATION_CHECK_INTERVAL_MS` (1 hour) and writes a snapshot only
if the current UTC day has none, so a restart or an outage cannot silently lose a day —
and re-running is an upsert, never a duplicate. Each run also deletes snapshots from
before the current season began (`season_start_timestamp`, fetched once per rollover): a
new season resets every ladder, so earlier curves describe a population that no longer
exists. Ticks also fire on sweep completion,
which is both the freshest moment to count and what covers startup: the bootstrap tick
always lands while the startup sweep holds the coordinator, so it defers.

### Season rollover

`GET /data/wow/pvp-season/{id}` carries `season_start_timestamp` always and
`season_end_timestamp` **only once the season has ended** — Blizzard writes it onto that
same record at the moment it finishes (season 41 ended 2026-08-11; season 42 has no end
date yet). So the season's own document is the signal, and it stays worth re-reading for
as long as no end date has appeared. Once one has, nothing about that season can change
again and it is cached for good.

`SeasonScheduler` re-checks every region daily, logging two distinct transitions at warn
level: a season ending (`Season 42 has ended in us at …`) and a rollover
(`Season rollover in us: 42 replaced by 43`). Between them a region can sit in a gap —
the old season finished, the next not yet started — which `hasEnded()` reports.

Season starts differ per region (us 2026-08-18 15:00Z, eu 08-19 04:00Z, kr/tw 08-19
23:00Z), which is why the representation purge is scoped per region rather than applied
globally.

The sweep's own cleanup takes its season id from the jobs it built, not from
`SeasonService`. A rollover detected part-way through a sweep would otherwise have the
cleanup act on the new season while every write of that sweep went to the old one.

`GET /health` reports each region's season id, name, start date, end date (null while
running), and last completed season.

## Season archive

Finished seasons live in their own collections so the live ones stay light:

```
archive_entries   { seasonId, region, bracket, characterId, characterName,
                    realmId, realmSlug, faction, rank, rating, played, won, lost }
archive_seasons   { seasonId, region, name, startsAt, endsAt, brackets, entries,
                    failedBrackets, archivedAt }
```

Rows are **self-contained** — name, realm and faction come from the leaderboard itself
rather than a reference into `characters`. Historical standings have to keep reading
correctly forever, and a character can be renamed, transferred or deleted long after the
season it belonged to.

**No profile enrichment.** The archive keeps only what the leaderboard endpoint returns.
Enrichment costs two requests per character and would describe the player _today_, not
during that season, so it would be both expensive and wrong.

### Running once, and resuming

`archive_seasons` is the progress marker: a season/region recorded there with no
`failedBrackets` is never fetched again.

A missing marker does **not** mean a missing season, though — a crash part-way through,
or a dropped markers collection, leaves the rows in place with nothing recording them.
So before fetching a season the service samples the data itself: three random brackets,
up to ten rows each. Finding rows is enough to skip the ~85 requests, and the marker is
written back from what is actually stored, so the next startup takes the cheap path
without sampling at all.

The sample is deliberately not a count — the point is to avoid work, not to trade one
expensive operation for another. It answers "is anything here", not "is this complete";
completeness is what `failedBrackets` records. A season with failures stays pending and is
retried whole — writes are upserts keyed on
`seasonId + region + bracket + characterId`, so a retry cannot duplicate anything.

The scheduler takes one season per pass and comes straight back while work remains,
pausing `ARCHIVE_SEASON_PAUSE_MS` between seasons and stopping entirely while any live
ingestion is running. Once the backlog is clear the interval only has to notice the current season
ending: `nextPending` offers the active season as soon as `SeasonService.hasEnded()`
reports an end date for it, so it is archived at runtime without a restart.

### Size, and the two levers

Blizzard serves seasons 22 onward (below that is 404). The full history is
**~19.7M rows, ~5.2GB** — driven by breadth, not depth: 83 brackets x 20 seasons x 4
regions, at roughly 3,700 entries each.

| Lever                                    | Effect                                                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `ARCHIVE_MAX_ENTRIES_PER_BRACKET` (5000) | Top N by rating per bracket. **Saves ~1%** — Blizzard already returns about 5,000, so this is a guard, not a reduction |
| `ARCHIVE_MIN_SEASON` (0 = all)           | The real lever. Seasons 35+ are the ones with per-spec shuffle ladders; starting there is roughly a third of the rows  |

## Sync endpoint

`POST /characters/sync` takes a whole character record and writes it to `characters` and
both per-spec ratings collections in one call, so a search API that has just fetched
fresh data can push it back rather than waiting for the next sweep.

```http
POST /characters/sync
{
  "seasonId": 42, "region": "us", "characterId": 195802602,
  "characterName": "Goküü", "realmId": 61, "realmSlug": "emerald-dream", "faction": "HORDE",
  "brackets": { "3v3": { "rank": 119, "rating": 2093, "played": 10, "won": 5, "lost": 5 } },
  "profile": { … }                                    // optional
}
→ 200 { "brackets": 2, "ignoredBrackets": ["shuffle-overall"],
        "shuffleRows": { "written": 1, "removed": 1 }, "blitzRows": { … } }
```

**The payload is authoritative for every bracket at once**, unlike the sweep which sees
one bracket at a time. A bracket absent from it is treated as one the character has left:
it is dropped from the document and its ratings row deleted. Sending a partial record
therefore deletes the rest — send the whole thing.

- `ratings` is **not accepted**; it is recomputed from `brackets`, which is the only way
  the mirror cannot drift. Unknown keys (`_id`, `ratings`, enrichment timestamps) are
  dropped, so a document read straight out of Mongo can be posted back unchanged.
- `shuffle-overall` / `blitz-overall` are ignored and reported in `ignoredBrackets`, to
  match what the sweep stores.
- **The endpoint never creates a character.** An id the collection does not already hold
  gets `404`, and no ratings rows are written for it — characters exist here because a
  ladder lists them, and inserting on push would fill the collection with players who
  hold no rating at all.
- **`profile` is merged field by field**, unlike `brackets`. An absent field leaves what
  is stored untouched; an explicit `null` clears it. A caller that knows only a
  character's title must not blank their spec by not mentioning it.
- Only the profile halves actually supplied get their enrichment timestamp stamped —
  summary fields move `profileFetchedAt`, spec fields move `specsFetchedAt` — so the
  worker still fills in whatever the caller left out.
- Brackets arriving without a `fetchedAt` are stamped with the request time.

**While a sweep is running the endpoint returns `409 Conflict`.** The sweep rewrites the
same documents, so interleaving would leave a record half from each source. Callers
should retry once it clears — a sweep takes about 35 seconds. Note the check is not a
lock: a sweep starting in the microseconds after it passes would overwrite the push with
its own (fresher) data, which is the harmless direction.

Bad payloads return `400` listing every offending field. A payload carrying no storable
brackets is also rejected: accepting it would blank the character's ladder data, and the
next sweep's unranked cleanup would then delete the document.

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
