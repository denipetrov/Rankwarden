import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, it } from 'vitest';

import * as inv from '../test/support/invariants.js';

/**
 * Every non-destructive invariant, one case each, against a live-check
 * database filled by the real binary from the real upstreams.
 *
 * Left out on purpose: I7 and I22 compare with what a fake served, which a
 * live run has no record of (the Raider.io cross-check does that job); I10 and
 * I15 drop a collection to prove independence, which is not something to do to
 * data that took a real pass to gather.
 */
const name = process.env.LIVE_DB ?? '';

if (!name.startsWith('rankwarden_check_')) {
  throw new Error(`LIVE_DB must name a rankwarden_check_* database, not "${name}"`);
}

const regions = (process.env.LIVE_REGIONS ?? 'us,eu,kr,tw,cn').split(',');

describe(`invariants over ${name}`, () => {
  let client: MongoClient;
  let db: Db;

  beforeAll(async () => {
    client = await MongoClient.connect(process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017');
    db = client.db(name);
  });

  afterAll(() => client?.close());

  const checks: [string, (db: Db) => Promise<void>][] = [
    ['I1 ratings mirror brackets', inv.expectRatingsMirrorBrackets],
    ['I2 no excluded bracket', inv.expectNoExcludedBrackets],
    ['I3 no orphan rating rows', inv.expectNoOrphanRatingRows],
    ['I4 no unranked characters', inv.expectNoUnrankedCharacters],
    ['I5 rows in the right family', inv.expectRowsInCorrectFamily],
    ['I6 identity uniqueness', inv.expectIdentityUniqueness],
    ['I8 index inventory', inv.expectIndexInventory],
    ['I9 PvP representation coherent', inv.expectRepresentationCoherent],
    ['I11 every character typed', inv.expectEveryCharacterTyped],
    ['I12 score is the sum of kept runs', (d) => inv.expectMplusScoreMatchesRuns(d)],
    ['I13 affixes referenced are stored', (d) => inv.expectMplusRunsReferenceKnownAffixes(d)],
    ['I14 no anonymised character', (d) => inv.expectNoAnonymisedMplusCharacters(d)],
    ['I16 rosterKeys mirror the roster', inv.expectMplusRosterKeysMirrorRoster],
    ['I17 keys well formed', inv.expectMplusCharacterKeysWellFormed],
    ['I18 no orphan M+ characters', inv.expectNoOrphanMplusCharacters],
    ['I19 archive markers match rows', inv.expectMplusArchiveMarkersMatchRows],
    ['I20 season dungeons catalogued', inv.expectMplusSeasonsReferenceKnownDungeons],
    ['I21 M+ representation coherent', inv.expectMplusRepresentationCoherent],
    ['I23 cutoffs well formed', (d) => inv.expectMplusCutoffsWellFormed(d, regions)],
    ['I24 regions coherent', (d) => inv.expectMplusRegionsCoherent(d)],
    ['I25 archive rows owned', inv.expectMplusArchiveRowsOwned],
    ['I26 ranked guilds resolve', inv.expectRaidBoardsResolve],
    ['I27 raid boards well formed', inv.expectRaidBoardsWellFormed],
  ];

  for (const [label, check] of checks) {
    it(label, () => check(db));
  }
});
