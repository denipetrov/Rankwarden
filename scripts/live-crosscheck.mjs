/**
 * L4 live smoke: reconcile our database against drustvar.com and, where they
 * disagree, against Blizzard itself.
 *
 * The plan's three-way cross-check. Two randomly drawn brackets are read out of
 * our own storage and compared row for row against the same board on
 * drustvar.com, which reads the same upstream on its own schedule. A
 * disagreement localises itself: if we and drustvar differ, the Blizzard
 * response decides which of us is wrong.
 *
 * Non-gating by design. Both sides are snapshots of a ladder that moves
 * continuously, so exact equality is not the standard — membership, ordering
 * and the character attributes are.
 *
 *   node scripts/live-crosscheck.mjs plan    --seed 20260909 --top 50
 *   node scripts/live-crosscheck.mjs compare --seed 20260909 --top 50
 */
import { MongoClient } from 'mongodb';
import { readFileSync, writeFileSync } from 'node:fs';

const DRUSTVAR = 'https://drustvar.com/api/v1/leaderboard/';
const PLAN_FILE = 'crosscheck-plan.json';

/**
 * Brackets that mean the same thing on both sides.
 *
 * drustvar serves one aggregated board per family: `shuffle-mage-fire` returns
 * the same rows as `shuffle`, which is the all-specs board this service
 * deliberately does not store (SKILLS.md §9.1). Only the three core brackets
 * are like-for-like, and only in the two regions drustvar covers — kr and tw
 * return no rows at all.
 */
const COMPARABLE_BRACKETS = ['2v2', '3v3', 'rbg'];
const COMPARABLE_REGIONS = ['us', 'eu'];

const FAMILY_OF = { '2v2': '2v2', '3v3': '3v3', rbg: 'rbg' };

/** Deterministic draw, so a run can be repeated and argued with. */
function mulberry32(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);

  return index === -1 ? fallback : process.argv[index + 1];
}

/** `Zëph` on `tarren-mill` — the only identity both sides agree on. */
const identity = (name, realmSlug) => `${String(name).toLocaleLowerCase()}@${realmSlug}`;

async function ourBoard(db, { region, bracket, seasonId, top }) {
  const rows = await db
    .collection(`${FAMILY_OF[bracket]}_ratings`)
    // §9.3: `$gt: 0`, so a stored zero never reaches a board.
    .find({ seasonId, region, bracket, rating: { $gt: 0 } })
    .sort({ rating: -1 })
    .limit(top)
    .toArray();

  const characters = await db
    .collection('characters')
    .find({ seasonId, region, characterId: { $in: rows.map((row) => row.characterId) } })
    .toArray();
  const byId = new Map(characters.map((character) => [character.characterId, character]));

  return rows.map((row) => {
    const character = byId.get(row.characterId) ?? {};
    const stats = character.brackets?.[bracket] ?? {};
    const profile = character.profile ?? {};

    return {
      characterId: row.characterId,
      name: character.characterName ?? null,
      realmSlug: character.realmSlug ?? null,
      faction: character.faction ?? null,
      rating: row.rating,
      rank: stats.rank ?? null,
      won: stats.won ?? null,
      lost: stats.lost ?? null,
      enriched: character.profileFetchedAt !== undefined,
      profileStatus: character.profileStatus ?? null,
      race: profile.race?.name ?? null,
      class: profile.class?.name ?? null,
      spec: profile.spec?.name ?? null,
      heroTalent: profile.heroTalentTree?.name ?? null,
    };
  });
}

async function drustvarBoard({ region, bracket, top }) {
  const params = new URLSearchParams({
    'search[bracket]': bracket,
    'search[region]': region,
    'search[limit]': String(top),
    'search[page]': '1',
    'search[sortby]': 'rank',
  });
  const response = await fetch(`${DRUSTVAR}?${params}`, {
    headers: { accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`drustvar ${response.status} for ${bracket}/${region}`);

  const body = await response.json();

  return (body.players ?? []).map((player) => ({
    name: player.name,
    realmSlug: player.realm?.slug ?? null,
    faction: player.faction ?? null,
    rating: player.rating,
    rank: player.rank,
    rankApprox: player.rank_approx === true,
    won: player.wins ?? null,
    lost: player.losses ?? null,
    race: player.race_name ?? null,
    class: player.class_name ?? null,
    spec: player.spec_name ?? null,
    heroTalent: player.hero_talent?.name ?? null,
  }));
}

async function plan(db) {
  const seed = Number(arg('seed', '1'));
  const top = Number(arg('top', '50'));
  const random = mulberry32(seed);

  const pool = COMPARABLE_REGIONS.flatMap((region) =>
    COMPARABLE_BRACKETS.map((bracket) => ({ region, bracket })),
  );

  const drawn = [];
  const remaining = [...pool];
  while (drawn.length < 2 && remaining.length > 0) {
    drawn.push(remaining.splice(Math.floor(random() * remaining.length), 1)[0]);
  }

  const state = await db.collection('season_state').find({}).toArray();
  const seasonOf = new Map(state.map((entry) => [entry.region, entry.seasonId]));

  const boards = [];
  for (const pick of drawn) {
    const seasonId = seasonOf.get(pick.region);
    const rows = await ourBoard(db, { ...pick, seasonId, top });
    boards.push({ ...pick, seasonId, top, characterIds: rows.map((row) => row.characterId) });
    console.log(
      `drew ${pick.region}/${pick.bracket} (season ${seasonId}): ${rows.length} rows, ` +
        `${rows.filter((row) => row.enriched).length} already enriched`,
    );
  }

  writeFileSync(PLAN_FILE, JSON.stringify({ seed, top, boards }, null, 2));
  console.log(`\nwrote ${PLAN_FILE}`);
}

/**
 * Makes exactly the drawn boards due for enrichment, and nothing else.
 *
 * Enrichment selects the stalest characters, and every one of the 157,931 this
 * sweep stored is equally stale — so which 500 a pass takes is effectively
 * arbitrary, and reaching a particular 100 of them means enriching most of the
 * population first. At Blizzard's 36,000/hour cap that is about nine hours for
 * two requests per character.
 *
 * So the queue is reordered rather than waited out: everyone is stamped as
 * freshly fetched, the drawn boards are stamped as never fetched, and the real
 * enrichment pass then fetches precisely them. Nothing here writes profile
 * data — every field compared later is fetched live from Blizzard by the
 * running service through its ordinary path. What is manipulated is only which
 * subset that path is pointed at.
 */
async function focus(db) {
  const { boards } = JSON.parse(readFileSync(PLAN_FILE, 'utf8'));
  const now = new Date();

  const parked = await db
    .collection('characters')
    .updateMany({}, { $set: { profileFetchedAt: now, specsFetchedAt: now } });
  console.log(`parked ${parked.modifiedCount} characters as freshly fetched`);

  let targeted = 0;
  for (const board of boards) {
    const result = await db.collection('characters').updateMany(
      {
        seasonId: board.seasonId,
        region: board.region,
        characterId: { $in: board.characterIds },
      },
      { $unset: { profileFetchedAt: '', specsFetchedAt: '', profileStatus: '', profile: '' } },
    );
    targeted += result.modifiedCount;
    console.log(`  ${board.region}/${board.bracket}: ${result.modifiedCount} made due`);
  }

  console.log(`
${targeted} characters are now the only ones enrichment will select`);
}

/** How far apart two boards are, and on what. */
function reconcile(ours, theirs) {
  const theirsBy = new Map(theirs.map((row) => [identity(row.name, row.realmSlug), row]));
  const oursBy = new Map(ours.map((row) => [identity(row.name, row.realmSlug), row]));

  const matched = [];
  for (const row of ours) {
    const other = theirsBy.get(identity(row.name, row.realmSlug));
    if (other) matched.push({ ours: row, theirs: other });
  }

  return {
    matched,
    onlyOurs: ours.filter((row) => !theirsBy.has(identity(row.name, row.realmSlug))),
    onlyTheirs: theirs.filter((row) => !oursBy.has(identity(row.name, row.realmSlug))),
  };
}

function summarise(label, { matched, onlyOurs, onlyTheirs }, ours, theirs) {
  const line = (text) => console.log(text);
  line(`\n${'='.repeat(78)}\n${label}\n${'='.repeat(78)}`);
  line(`ours: ${ours.length} rows   drustvar: ${theirs.length} rows   overlap: ${matched.length}`);

  if (matched.length === 0) {
    line('no shared identities — nothing further to compare');
    return { label, overlap: 0 };
  }

  const ratingDiffs = matched.map((pair) => Math.abs(pair.ours.rating - pair.theirs.rating));
  const exactRating = ratingDiffs.filter((diff) => diff === 0).length;
  const rankDiffs = matched
    .filter((pair) => pair.ours.rank !== null)
    .map((pair) => Math.abs(pair.ours.rank - pair.theirs.rank));
  const factionMatches = matched.filter(
    (pair) => (pair.ours.faction ?? '').toLowerCase() === (pair.theirs.faction ?? '').toLowerCase(),
  ).length;
  const recordMatches = matched.filter(
    (pair) => pair.ours.won === pair.theirs.won && pair.ours.lost === pair.theirs.lost,
  ).length;

  line(`\nstandings`);
  line(`  rating identical      ${exactRating}/${matched.length}`);
  line(`  rating max drift      ${Math.max(...ratingDiffs)}`);
  line(`  rank max drift        ${rankDiffs.length ? Math.max(...rankDiffs) : 'n/a'}`);
  line(`  faction agrees        ${factionMatches}/${matched.length}`);
  line(`  win/loss agrees       ${recordMatches}/${matched.length}`);

  const enriched = matched.filter((pair) => pair.ours.enriched && pair.ours.class);
  line(`\ncharacter detail (${enriched.length} of ${matched.length} enriched)`);

  const field = (key) => {
    const both = enriched.filter((pair) => pair.ours[key] && pair.theirs[key]);
    const agree = both.filter(
      (pair) => pair.ours[key].toLowerCase() === pair.theirs[key].toLowerCase(),
    );

    return { agree: agree.length, of: both.length, misses: both.filter((p) => !agree.includes(p)) };
  };

  const detail = {};
  for (const key of ['race', 'class', 'spec', 'heroTalent']) {
    detail[key] = field(key);
    line(`  ${key.padEnd(20)}${detail[key].agree}/${detail[key].of}`);
  }

  for (const [key, result] of Object.entries(detail)) {
    for (const miss of result.misses.slice(0, 5)) {
      line(
        `    MISMATCH ${key}: ${miss.ours.name}-${miss.ours.realmSlug} ` +
          `ours="${miss.ours[key]}" drustvar="${miss.theirs[key]}"`,
      );
    }
  }

  for (const row of onlyOurs.slice(0, 5)) {
    line(`  only in ours:     #${row.rank} ${row.name}-${row.realmSlug} ${row.rating}`);
  }
  for (const row of onlyTheirs.slice(0, 5)) {
    line(`  only in drustvar: #${row.rank} ${row.name}-${row.realmSlug} ${row.rating}`);
  }

  return {
    label,
    overlap: matched.length,
    exactRating,
    maxRatingDrift: Math.max(...ratingDiffs),
    detail: Object.fromEntries(
      Object.entries(detail).map(([key, value]) => [key, `${value.agree}/${value.of}`]),
    ),
  };
}

/**
 * Asks Blizzard who is right about the rows the two sides disagree on.
 *
 * The point of a three-way check. A spec or hero-talent difference is not
 * evidence against either store on its own — both are snapshots of a value that
 * changes the moment a player respecs, and they were taken at different times.
 * Only the upstream settles it, so each disagreement is re-fetched live and
 * scored against both sides.
 *
 * Run with `node --env-file=.env`, which is where the credentials come from.
 * Nothing here prints them.
 */
async function arbitrate(db) {
  const id = process.env.BLIZZARD_CLIENT_ID;
  const secret = process.env.BLIZZARD_CLIENT_SECRET;
  if (!id || !secret) throw new Error('run with --env-file=.env for credentials');

  const auth = await fetch('https://oauth.battle.net/token', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });
  if (!auth.ok) throw new Error(`oauth ${auth.status}`);
  const { access_token: token } = await auth.json();

  const get = async (region, path) => {
    const url =
      `https://${region}.api.blizzard.com/${path}` +
      `?namespace=profile-${region}&locale=en_US`;
    const response = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!response.ok) return { error: response.status };

    return response.json();
  };

  const { top, boards } = JSON.parse(readFileSync(PLAN_FILE, 'utf8'));
  const tally = { ours: 0, drustvar: 0, neither: 0 };

  for (const board of boards) {
    const ours = await ourBoard(db, board);
    const theirs = await drustvarBoard({ ...board, top });
    const { matched } = reconcile(ours, theirs);

    const disputed = matched.filter(
      (pair) =>
        pair.ours.enriched &&
        pair.ours.spec &&
        pair.theirs.spec &&
        (pair.ours.spec.toLowerCase() !== pair.theirs.spec.toLowerCase() ||
          (pair.ours.heroTalent ?? '').toLowerCase() !==
            (pair.theirs.heroTalent ?? '').toLowerCase()),
    );

    console.log(`
${board.region}/${board.bracket}: ${disputed.length} disputed rows`);

    for (const pair of disputed) {
      const name = encodeURIComponent(pair.ours.name.toLocaleLowerCase());
      const specs = await get(
        board.region,
        `profile/wow/character/${pair.ours.realmSlug}/${name}/specializations`,
      );

      if (specs.error) {
        console.log(`  ${pair.ours.name}-${pair.ours.realmSlug}: blizzard ${specs.error}`);
        continue;
      }

      const live = specs.active_specialization?.name ?? null;
      const liveTree = specs.active_hero_talent_tree?.name ?? null;
      const agreesWithUs =
        live === pair.ours.spec && (liveTree ?? null) === (pair.ours.heroTalent ?? null);
      const agreesWithThem =
        live === pair.theirs.spec && (liveTree ?? null) === (pair.theirs.heroTalent ?? null);
      const verdict = agreesWithUs ? 'ours' : agreesWithThem ? 'drustvar' : 'neither';
      tally[verdict] += 1;

      console.log(
        `  ${pair.ours.name}-${pair.ours.realmSlug}: blizzard says ${live}/${liveTree} — ` +
          `ours ${pair.ours.spec}/${pair.ours.heroTalent}, ` +
          `drustvar ${pair.theirs.spec}/${pair.theirs.heroTalent} => ${verdict.toUpperCase()}`,
      );
    }
  }

  console.log(`
verdicts: ${JSON.stringify(tally)}`);
}

async function compare(db) {
  const { top, boards } = JSON.parse(readFileSync(PLAN_FILE, 'utf8'));
  const results = [];

  for (const board of boards) {
    const ours = await ourBoard(db, board);
    const theirs = await drustvarBoard({ ...board, top });
    results.push(
      summarise(
        `${board.region.toUpperCase()} ${board.bracket} — season ${board.seasonId}, top ${top}`,
        reconcile(ours, theirs),
        ours,
        theirs,
      ),
    );
  }

  console.log(`\n${'='.repeat(78)}\nsummary\n${'='.repeat(78)}`);
  console.log(JSON.stringify(results, null, 2));
}

const client = new MongoClient(process.env.MONGODB_URI ?? 'mongodb://localhost:27017');
await client.connect();
const db = client.db(process.env.MONGODB_DB ?? 'rankwarden');

try {
  const command = process.argv[2];
  if (command === 'plan') await plan(db);
  else if (command === 'focus') await focus(db);
  else if (command === 'compare') await compare(db);
  else if (command === 'arbitrate') await arbitrate(db);
  else throw new Error('usage: live-crosscheck.mjs <plan|focus|compare|arbitrate>');
} finally {
  await client.close();
}
