#!/usr/bin/env node
/**
 * Raid and guild live cross-check (raid test plan, section X).
 *
 * Compares the boards the real binary stored in a check database with what
 * Raider.io serves for the same boards, page by page, and the guilds they name.
 *
 *   node --env-file=.env scripts/live-raid-crosscheck.mjs --db rankwarden_check_raids_<date> [--seed N] [--raids N]
 *
 * The database must be a `rankwarden_check_*` one and is only read. The key
 * comes from the environment and is never printed. Run it with the app stopped.
 */
import { MongoClient } from 'mongodb';

const args = process.argv.slice(2);
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

let last = 0;
async function rio(path, params) {
  const wait = last + 100 - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  last = Date.now();
  const query = new URLSearchParams(params);
  const url = `https://raider.io/api/v1/${path}?${query}&access_key=${encodeURIComponent(key)}`;
  for (let attempt = 1; ; attempt += 1) {
    const response = await fetch(url, { headers: { accept: 'application/json' } });
    if (response.ok) return { status: 200, body: await response.json() };
    if (response.status >= 500 && attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 3_000 * attempt));
      continue;
    }
    return { status: response.status, body: null };
  }
}

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const client = await MongoClient.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017');
const db = client.db(dbName);

try {
  const raids = await db.collection('raids').find({}).sort({ expansionId: 1, id: 1 }).toArray();
  const guildCount = await db.collection('guilds').countDocuments();

  // ---- census over everything stored ----
  let boards = 0;
  let unstamped = 0;
  const sizes = {};
  const short = [];
  for (const raid of raids) {
    for (const [region, byDifficulty] of Object.entries(raid.guilds ?? {})) {
      for (const [difficulty, board] of Object.entries(byDifficulty)) {
        boards += 1;
        if (!raid.guildsUpdatedAt?.[region]?.[difficulty]) unstamped += 1;
        sizes[board.length] = (sizes[board.length] ?? 0) + 1;
        if (board.length > 0 && board.length < 100) {
          short.push(
            `${raid.slug}/${region}/${difficulty}: ${board.length} stored, last rank ${board.at(-1).rank}`,
          );
        }
      }
    }
  }
  console.log(
    `== census == ${raids.length} raids, ${boards} boards stored (${unstamped} unstamped), ${guildCount} guilds`,
  );
  console.log('board sizes:', JSON.stringify(sizes));

  // ---- sampled boards against Raider.io ----
  const rand = mulberry32(Number(opt('seed', '20261005')));
  const wanted = Number(opt('raids', '6'));
  const now = new Date();
  const legion = raids.filter((raid) => raid.expansionId === 6);
  const open = raids.filter((raid) => Object.values(raid.ends ?? {}).some((end) => end > now));
  const rest = raids.filter((raid) => !legion.includes(raid) && !open.includes(raid));
  const pick = (list, n) => [...list].sort(() => rand() - 0.5).slice(0, n);
  const sample = [...pick(legion, 2), ...pick(open, 1), ...pick(rest, Math.max(0, wanted - 3))];

  const totals = {
    boards: 0,
    equal: 0,
    truncated: 0,
    lostEntries: 0,
    rankDiff: 0,
    bossDiff: 0,
    unreadable: 0,
  };
  const truncated = [];
  const seenGuilds = new Map();

  for (const raid of sample) {
    for (const [region, byDifficulty] of Object.entries(raid.guilds ?? {})) {
      for (const [difficulty, stored] of Object.entries(byDifficulty)) {
        const served = [];
        let failed = false;
        for (let page = 0; page < 5; page += 1) {
          const res = await rio('raiding/raid-rankings', {
            raid: raid.slug,
            difficulty,
            region,
            limit: 20,
            page,
          });
          if (res.status !== 200) {
            failed = true;
            break;
          }
          served.push(...res.body.raidRankings);
          if (res.body.raidRankings.length === 0) break;
        }
        if (failed) {
          totals.unreadable += 1;
          continue;
        }
        totals.boards += 1;
        for (const entry of served) seenGuilds.set(entry.guild.id, entry.guild);

        const mineByGuild = new Map(stored.map((entry) => [entry.guildId, entry]));
        const common = served.filter((entry) => mineByGuild.has(entry.guild.id));
        const diffs = common.filter(
          (entry) => mineByGuild.get(entry.guild.id).rank !== entry.rank,
        ).length;
        const bossDiffs = common.filter((entry) => {
          const mine = mineByGuild.get(entry.guild.id);
          return (
            mine.encountersDefeated.length !== (entry.encountersDefeated ?? []).length ||
            mine.encountersPulled.length !== (entry.encountersPulled ?? []).length ||
            [...mine.encountersDefeated, ...mine.encountersPulled].some(
              (boss) => boss.encounterId === null,
            )
          );
        }).length;
        // Only a stored board that is a strict prefix of the served one is
        // truncation; anything else on an open raid is the race moving.
        const isPrefix =
          stored.length < served.length &&
          stored.every((entry, index) => served[index]?.guild.id === entry.guildId);
        if (isPrefix) {
          totals.truncated += 1;
          totals.lostEntries += served.length - stored.length;
          truncated.push(
            `${raid.slug}/${region}/${difficulty}: stored ${stored.length}, Raider.io serves ${served.length}`,
          );
        } else if (stored.length === served.length && diffs === 0) {
          totals.equal += 1;
        }
        if (diffs > 0) totals.rankDiff += 1;
        if (bossDiffs > 0) totals.bossDiff += 1;
      }
    }
  }

  // ---- guild documents against what the boards served ----
  const docs = await db
    .collection('guilds')
    .find({ id: { $in: [...seenGuilds.keys()] } })
    .toArray();
  const byId = new Map(docs.map((guild) => [guild.id, guild]));
  let guildsCompared = 0;
  let guildsDiffering = 0;
  for (const [id, theirs] of seenGuilds) {
    const mine = byId.get(id);
    if (!mine) continue; // on a part of a board that was not stored
    guildsCompared += 1;
    if (
      mine.name !== theirs.name ||
      mine.faction !== (theirs.faction ?? null) ||
      mine.region !== (theirs.region?.slug ?? null) ||
      mine.realm?.slug !== theirs.realm?.slug ||
      mine.logo !== (theirs.logo ?? null)
    ) {
      guildsDiffering += 1;
    }
  }

  console.log(`\n== sample == raids: ${sample.map((raid) => raid.slug).join(', ')}`);
  console.log(JSON.stringify(totals));
  console.log(`guild documents compared ${guildsCompared}, differing ${guildsDiffering}`);
  if (truncated.length) {
    console.log(`\ntruncated boards (stored is a strict prefix of what is served):`);
    console.log(`  ${truncated.join('\n  ')}`);
  }
  if (short.length) {
    console.log(`\nall stored boards shorter than 100 (${short.length}):`);
    console.log(`  ${short.slice(0, 80).join('\n  ')}`);
  }
} finally {
  await client.close();
}
