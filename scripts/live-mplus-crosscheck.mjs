#!/usr/bin/env node
/**
 * Mythic+ live cross-check (test plan section X).
 *
 * Compares what the real binary stored from a real pass against what Raider.io
 * publishes *separately* — per-dungeon boards, character profiles, cutoffs —
 * and answers the questions a fake cannot (region coherence, board movement,
 * cutoffs for a new season).
 *
 *   node --env-file=.env scripts/live-mplus-crosscheck.mjs <command> --db rankwarden_check_mplus_<date> [options]
 *
 * Commands: census, boards, characters, cutoffs, reread, newseason, all.
 * Options:  --seed N (default 20260928) --pages N --log <app log path, for census>
 *
 * Rules (MPLUS-TESTING.md §8): the database must be a `rankwarden_check_*` one
 * and is only ever read here; the Raider.io key comes from the environment and
 * is never printed — every url in output is built without it. Run it with the
 * app stopped, so its requests and the app's do not share one minute.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { MongoClient } from 'mongodb';

const BASE = 'https://raider.io/api/v1';
const REGIONS_COMPARED = ['us', 'eu', 'kr', 'tw'];
const ALL_REGIONS = ['us', 'eu', 'kr', 'tw', 'cn'];

const args = process.argv.slice(2);
const command = args[0] ?? 'all';
const opt = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : fallback;
};

const dbName = opt('db', '');
if (!dbName.startsWith('rankwarden_check_')) {
  console.error(`--db must name a rankwarden_check_* database, not "${dbName}"`);
  process.exit(2);
}
const key = process.env.RAIDER_IO_API_KEY ?? '';
if (!key) {
  console.error('RAIDER_IO_API_KEY is not set; run with node --env-file=.env');
  process.exit(2);
}
const seed = Number(opt('seed', '20260928'));
const out = opt('out', null);

// ---- Raider.io, paced and keyless in every message -------------------------

let last = 0;
async function rio(path, params) {
  const wait = last + 90 - Date.now(); // ~11 requests a second, under the app's own pace
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  last = Date.now();

  const shown = `${BASE}/${path}?${new URLSearchParams(params)}`;
  const url = `${shown}&access_key=${encodeURIComponent(key)}`;

  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (response.ok) return { status: 200, body: await response.json(), url: shown };
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      continue;
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      /* no body */
    }
    return { status: response.status, body, url: shown };
  }
}

// ---- seeded draw -------------------------------------------------------------

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(seed);
const pick = (list, n) => {
  const copy = [...list];
  const chosen = [];
  while (chosen.length < n && copy.length)
    chosen.push(copy.splice(Math.floor(rand() * copy.length), 1)[0]);
  return chosen;
};

const nameKey = (name) => name.normalize('NFC').toLowerCase();
const rosterSig = (roster) =>
  roster
    .map((m) => `${nameKey(m.name)}@${m.realm}:${m.spec ?? '-'}`)
    .sort()
    .join('|');

// ---- the stored side -----------------------------------------------------------

const client = await MongoClient.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017');
const db = client.db(dbName);
const runsCol = db.collection('mplus_runs');
const charsCol = db.collection('mplus_characters');

const state = await db.collection('mplus_season_state').find().toArray();
const seasonOf = Object.fromEntries(state.map((entry) => [entry.region, entry.season]));
const season = seasonOf.us;
const seasonDoc = await db.collection('mplus_seasons').findOne({ slug: season });
const dungeons = await db
  .collection('mplus_dungeons')
  .find({ id: { $in: seasonDoc.dungeonIds } })
  .toArray();

async function passFacts(region) {
  const [first] = await runsCol
    .aggregate([
      { $match: { season, region } },
      {
        $group: {
          _id: null,
          runs: { $sum: 1 },
          floor: { $min: '$score' },
          at: { $min: '$fetchedAt' },
          missed: { $sum: { $cond: [{ $ifNull: ['$missedSince', false] }, 1, 0] } },
        },
      },
    ])
    .toArray();
  return first ?? { runs: 0, floor: null, at: null, missed: 0 };
}

const report = { db: dbName, season, seed, at: new Date().toISOString() };

// ---- X5 + X6a: census over what was stored ---------------------------------

async function census() {
  const logPath = opt('log', null);
  const served = {};
  if (logPath) {
    const text = readFileSync(logPath, 'utf8').replace(/\x1b\[[0-9;]*m/g, '');
    for (const match of text.matchAll(/Mythic\+ (\w\w): (\d+) runs over (\d+) page/g)) {
      served[match[1]] = { rows: Number(match[2]), pages: Number(match[3]) };
    }
  }

  const regions = {};
  for (const region of ALL_REGIONS) {
    const facts = await passFacts(region);
    const [foreign] = await runsCol
      .aggregate([
        { $match: { season, region } },
        { $unwind: '$roster' },
        { $match: { 'roster.anonymized': false } },
        {
          $group: {
            _id: null,
            members: { $sum: 1 },
            foreign: { $sum: { $cond: [{ $ne: ['$roster.region', region] }, 1, 0] } },
            examples: {
              $addToSet: {
                $cond: [
                  { $ne: ['$roster.region', region] },
                  {
                    $concat: [
                      '$roster.region',
                      '/',
                      '$roster.realmSlug',
                      '/',
                      '$roster.characterName',
                    ],
                  },
                  null,
                ],
              },
            },
          },
        },
      ])
      .toArray();
    const rosterSizes = await runsCol
      .aggregate([
        { $match: { season, region } },
        { $group: { _id: { $size: '$roster' }, runs: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    const anonymised = await runsCol
      .aggregate([
        { $match: { season, region } },
        { $unwind: '$roster' },
        { $match: { 'roster.anonymized': true } },
        { $count: 'n' },
      ])
      .toArray();

    regions[region] = {
      storedRuns: facts.runs,
      servedRows: served[region]?.rows ?? null,
      pages: served[region]?.pages ?? null,
      duplicatesAcrossPages: served[region] ? served[region].rows - facts.runs : null,
      windowFloorScore: facts.floor,
      missedSince: facts.missed,
      characters: await charsCol.countDocuments({ season, region }),
      namedMembers: foreign?.members ?? 0,
      foreignRegionMembers: foreign?.foreign ?? 0,
      foreignExamples: (foreign?.examples ?? []).filter(Boolean).slice(0, 5),
      anonymisedSlots: anonymised[0]?.n ?? 0,
      rosterSizes: Object.fromEntries(rosterSizes.map((row) => [row._id, row.runs])),
    };
  }

  const coverage = await charsCol
    .aggregate([
      { $match: { season } },
      { $group: { _id: '$dungeonsCovered', n: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .toArray();

  report.census = {
    regions,
    dungeonsInSeason: seasonDoc.dungeonIds.length,
    dungeonsCoveredDistribution: Object.fromEntries(coverage.map((row) => [row._id, row.n])),
  };
  console.log('\n== X5/X6a census ==');
  for (const [region, row] of Object.entries(regions)) {
    console.log(
      `${region}: ${row.storedRuns} runs stored of ${row.servedRows ?? '?'} served ` +
        `(${row.duplicatesAcrossPages ?? '?'} duplicates), ${row.characters} characters, ` +
        `foreign-region members ${row.foreignRegionMembers}/${row.namedMembers}, anonymised slots ${row.anonymisedSlots}, ` +
        `roster sizes ${JSON.stringify(row.rosterSizes)}`,
    );
  }
  console.log(
    `dungeonsCovered (of ${seasonDoc.dungeonIds.length}):`,
    JSON.stringify(report.census.dungeonsCoveredDistribution),
  );
}

// ---- X2: two (region, dungeon) boards against Raider.io's per-dungeon board ---

function toTheirs(ranking) {
  return {
    id: ranking.run.keystone_run_id,
    score: ranking.score,
    level: ranking.run.mythic_level,
    completedAt: new Date(ranking.run.completed_at),
    roster: rosterSig(
      ranking.run.roster
        .filter((m) => !(m.character.id === 0 || m.character.realm?.slug === 'anonymous'))
        .map((m) => ({
          name: m.character.name,
          realm: m.character.realm.slug,
          spec: m.character.spec?.id || null,
        })),
    ),
  };
}

async function boards() {
  const pages = Number(opt('pages', '30'));
  const pairs = pick(
    REGIONS_COMPARED.flatMap((region) => dungeons.map((dungeon) => ({ region, dungeon }))),
    2,
  );
  report.boards = [];

  for (const { region, dungeon } of pairs) {
    const facts = await passFacts(region);
    const theirs = [];
    for (let page = 0; page < pages; page += 1) {
      const res = await rio('mythic-plus/runs', { season, region, dungeon: dungeon.slug, page });
      if (res.status !== 200) {
        console.log(`  ${res.status} for ${res.url}`);
        break;
      }
      theirs.push(...res.body.rankings.map(toTheirs));
      if (res.body.rankings.length === 0) break;
    }
    const theirLast = theirs.at(-1)?.score ?? Infinity;
    const bound = Math.max(theirLast, facts.floor);

    const oursRows = await runsCol
      .find({
        season,
        region,
        'dungeon.id': dungeon.id,
        missedSince: { $exists: false },
        score: { $gt: bound },
      })
      .toArray();
    const ours = new Map(
      oursRows.map((run) => [
        run.keystoneRunId,
        {
          score: run.score,
          level: run.mythicLevel,
          roster: rosterSig(
            run.roster
              .filter((m) => !m.anonymized)
              .map((m) => ({ name: m.characterName, realm: m.realmSlug, spec: m.specId })),
          ),
        },
      ]),
    );
    const theirMap = new Map(theirs.filter((run) => run.score > bound).map((run) => [run.id, run]));

    const missing = [...theirMap.values()].filter((run) => !ours.has(run.id));
    const newer = missing.filter((run) => run.completedAt > facts.at);
    const missed = missing.filter((run) => run.completedAt <= facts.at);
    const extra = [...ours.keys()].filter((id) => !theirMap.has(id));
    let scoreDiff = 0;
    let levelDiff = 0;
    let rosterDiff = 0;
    const rosterExamples = [];
    for (const [id, run] of theirMap) {
      const mine = ours.get(id);
      if (!mine) continue;
      if (Math.abs(mine.score - run.score) > 0.05) scoreDiff += 1;
      if (mine.level !== run.level) levelDiff += 1;
      if (mine.roster !== run.roster) {
        rosterDiff += 1;
        if (rosterExamples.length < 3)
          rosterExamples.push({ id, ours: mine.roster, theirs: run.roster });
      }
    }

    const row = {
      region,
      dungeon: dungeon.slug,
      comparedAbove: bound,
      theirs: theirMap.size,
      ours: ours.size,
      common: theirMap.size - missing.length,
      newerThanOurPass: newer.length,
      missedByUs: missed.map((run) => ({
        id: run.id,
        score: run.score,
        completedAt: run.completedAt,
      })),
      notOnTheirBoard: extra,
      scoreDiff,
      levelDiff,
      rosterDiff,
      rosterExamples,
    };
    report.boards.push(row);
    console.log(
      `\n== X2 ${region}/${dungeon.slug} (scores > ${bound}) ==\n` +
        `their ${row.theirs}, ours ${row.ours}, common ${row.common}; newer than our pass ${row.newerThanOurPass}; ` +
        `missed by us ${missed.length}; ours not on their board ${extra.length}; ` +
        `score/level/roster differences ${scoreDiff}/${levelDiff}/${rosterDiff}`,
    );
  }
}

// ---- X3: characters against their Raider.io profiles ---------------------------

async function characters() {
  const top = await charsCol
    .find({ season, region: { $in: REGIONS_COMPARED } })
    .sort({ mythicScore: -1 })
    .limit(200)
    .toArray();
  const tail = await charsCol
    .find({ season, region: { $in: REGIONS_COMPARED } })
    .sort({ mythicScore: 1 })
    .limit(1_000)
    .toArray();
  const chosen = [
    ...pick(top, 20).map((c) => ['top', c]),
    ...pick(tail, 20).map((c) => ['tail', c]),
  ];
  report.characters = [];
  let higher = 0;
  let shouldEqual = 0;
  let scoreAbove = 0;

  for (const [group, character] of chosen) {
    const res = await rio('characters/profile', {
      region: character.region,
      realm: character.realmSlug,
      name: character.characterName,
      fields: 'mythic_plus_scores_by_season:current,mythic_plus_best_runs:all',
    });
    const row = {
      group,
      key: character.key,
      ours: character.mythicScore,
      covered: character.dungeonsCovered,
      status: res.status,
      issues: [],
    };
    report.characters.push(row);
    if (res.status !== 200) {
      row.issues.push(`profile ${res.status}`);
      continue;
    }

    const theirScore = res.body.mythic_plus_scores_by_season?.[0]?.scores?.all ?? null;
    row.theirs = theirScore;
    if (theirScore !== null && character.mythicScore > theirScore + 0.5) {
      scoreAbove += 1;
      row.issues.push(`our score ${character.mythicScore} above theirs ${theirScore}`);
    }

    const best = res.body.mythic_plus_best_runs ?? [];
    for (const entry of character.dungeonRuns) {
      const theirs =
        best.find((run) => run.keystone_run_id === entry.keystoneRunId) ??
        best.find(
          (run) => run.short_name === entry.dungeon.shortName || run.dungeon === entry.dungeon.name,
        );
      if (!theirs) {
        row.issues.push(`${entry.dungeon.shortName}: no best run on their profile`);
        continue;
      }
      if (entry.score > theirs.score + 0.05) {
        higher += 1;
        row.issues.push(`${entry.dungeon.shortName}: ours ${entry.score} > theirs ${theirs.score}`);
      }
      if (theirs.keystone_run_id !== entry.keystoneRunId) {
        const inWindow = await runsCol.countDocuments({
          season,
          region: character.region,
          keystoneRunId: theirs.keystone_run_id,
        });
        if (inWindow > 0) {
          shouldEqual += 1;
          row.issues.push(
            `${entry.dungeon.shortName}: their best ${theirs.keystone_run_id} is in our window but we kept ${entry.keystoneRunId}`,
          );
        }
      }
    }
  }

  const failed = report.characters.filter((row) => row.status !== 200).length;
  console.log(
    `\n== X3 characters (${chosen.length}: 20 top, 20 tail) ==\n` +
      `profiles unavailable ${failed}; dungeons where ours > theirs ${higher}; ` +
      `their in-window best not kept ${shouldEqual}; our score above theirs ${scoreAbove}`,
  );
  for (const row of report.characters.filter((r) => r.issues.length)) {
    console.log(`  ${row.group} ${row.key}: ${row.issues.join('; ')}`);
  }
}

// ---- X4: cutoffs as stored against cutoffs as served ---------------------------

const TIERS = [
  'keystoneExplorer',
  'keystoneConqueror',
  'keystoneMaster',
  'keystoneHero',
  'keystoneLegend',
  'keystoneMyth',
];
const QUANTILES = ['p999', 'p990'];

async function cutoffs() {
  const fresh = await db.collection('mplus_seasons').findOne({ slug: season });
  report.cutoffs = {};
  console.log('\n== X4 cutoffs ==');

  for (const region of ALL_REGIONS) {
    const stored = fresh.cutoffs?.[region];
    const res = await rio('mythic-plus/season-cutoffs', { season, region });
    const row = {
      storedStatus: stored?.status ?? null,
      served: res.status,
      compared: 0,
      differences: [],
      absentAsExpected: 0,
    };
    report.cutoffs[region] = row;
    if (res.status !== 200 || !stored) {
      console.log(`${region}: stored ${row.storedStatus}, served ${res.status}`);
      continue;
    }
    const payload = res.body.cutoffs;
    row.theirUpdatedAt = payload.updatedAt;
    row.ourUpdatedAt = stored.updatedAt;
    const moved =
      String(new Date(payload.updatedAt).getTime()) !==
      String(new Date(stored.updatedAt).getTime());
    row.movedSinceOurRead = moved;

    for (const [names, bag] of [
      [TIERS, stored.keystones ?? {}],
      [QUANTILES, stored.quantiles ?? {}],
    ]) {
      for (const name of names) {
        const theirs = payload[name];
        const ours = bag[name];
        if (!theirs) {
          if (ours) row.differences.push(`${name}: stored but served null`);
          else row.absentAsExpected += 1;
          continue;
        }
        if (!ours) {
          row.differences.push(`${name}: served but not stored`);
          continue;
        }
        if ((theirs.score ?? null) !== (ours.score ?? null))
          row.differences.push(`${name}.score ${ours.score} vs ${theirs.score}`);
        for (const side of ['all', 'alliance', 'horde']) {
          row.compared += 1;
          const a = ours[side]?.minScore ?? null;
          const b = theirs[side]?.quantileMinValue ?? null;
          if (a !== b) row.differences.push(`${name}.${side} ${a} vs ${b}`);
        }
      }
    }
    console.log(
      `${region}: ${row.compared} figures compared, ${row.differences.length} differ, ` +
        `${row.absentAsExpected} tiers null upstream and absent here` +
        (moved ? ' (Raider.io recomputed since our read)' : ' (same Raider.io computation)') +
        (row.differences.length ? `\n  ${row.differences.slice(0, 6).join('\n  ')}` : ''),
    );
  }
}

// ---- X6b: re-read the top of each board and diff --------------------------------

async function reread() {
  const pages = Number(opt('pages', '50'));
  report.reread = {};
  console.log(`\n== X6b re-read pages 0-${pages - 1} ==`);

  for (const region of ALL_REGIONS) {
    const facts = await passFacts(region);
    const theirs = [];
    for (let page = 0; page < pages; page += 1) {
      const res = await rio('mythic-plus/runs', { season, region, dungeon: 'all', page });
      if (res.status !== 200 || res.body.rankings.length === 0) break;
      theirs.push(...res.body.rankings.map(toTheirs));
    }
    const floor = theirs.at(-1)?.score ?? 0;
    const ids = new Set(theirs.map((run) => run.id));
    const stored = await runsCol
      .find(
        { season, region, score: { $gt: floor } },
        { projection: { keystoneRunId: 1, missedSince: 1 } },
      )
      .toArray();
    const storedIds = new Set(stored.map((run) => run.keystoneRunId));
    const skipped = theirs.filter(
      (run) => run.score > floor && run.completedAt <= facts.at && !storedIds.has(run.id),
    );
    const newer = theirs.filter(
      (run) => run.score > floor && run.completedAt > facts.at && !storedIds.has(run.id),
    );
    const gone = stored.filter((run) => !ids.has(run.keystoneRunId));
    report.reread[region] = {
      reread: theirs.length,
      floor,
      skippedDuringPass: skipped.length,
      newerSincePass: newer.length,
      goneSincePass: gone.length,
      skippedIds: skipped.slice(0, 10).map((r) => r.id),
    };
    console.log(
      `${region}: ${theirs.length} re-read above ${floor}; skipped during our pass ${skipped.length}; newer since ${newer.length}; stored but gone ${gone.length}`,
    );
  }
}

// ---- X8: cutoffs for the newest and any unopened season -------------------------

async function newseason() {
  report.newseason = [];
  console.log('\n== X8 cutoffs for new seasons ==');
  const now = Date.now();
  const listed = [];
  for (const expansion of [11, 12]) {
    const res = await rio('mythic-plus/static-data', { expansion_id: expansion });
    if (res.status === 200) listed.push(...res.body.seasons.map((s) => ({ ...s, expansion })));
  }
  const starts = (s) =>
    Math.min(
      ...Object.values(s.starts ?? {})
        .map((v) => Date.parse(v))
        .filter(Number.isFinite),
    );
  const main = listed.filter((s) => s.is_main_season !== false);
  const newest = [...main].sort((a, b) => starts(b) - starts(a));
  const candidates = [
    ...new Set([...newest.filter((s) => starts(s) > now), ...newest.slice(0, 1)]),
  ];

  for (const s of candidates) {
    const res = await rio('mythic-plus/season-cutoffs', { season: s.slug, region: 'us' });
    const row = {
      season: s.slug,
      opens: Number.isFinite(starts(s)) ? new Date(starts(s)).toISOString() : null,
      opened: starts(s) <= now,
      status: res.status,
      message: res.status === 200 ? null : (res.body?.message ?? null),
      tiersPresent: res.status === 200 ? TIERS.filter((t) => res.body.cutoffs?.[t]) : null,
    };
    report.newseason.push(row);
    console.log(
      `${row.season} (opens ${row.opens}, ${row.opened ? 'open' : 'not open yet'}): ${row.status}${row.message ? ` "${row.message}"` : ''}${row.tiersPresent ? ` tiers ${row.tiersPresent.join(', ')}` : ''}`,
    );
  }
  if (!candidates.some((s) => starts(s) > now)) console.log('No listed season has yet to open.');
}

// ---- run -----------------------------------------------------------------------

const commands = { census, boards, characters, cutoffs, reread, newseason };
try {
  if (command === 'all') {
    for (const run of Object.values(commands)) await run();
  } else if (commands[command]) {
    await commands[command]();
  } else {
    console.error(`unknown command ${command}`);
    process.exitCode = 2;
  }
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
} finally {
  await client.close();
}
