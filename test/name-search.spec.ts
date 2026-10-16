import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from 'mongodb';

import { searchNameOf } from '../src/common/utils/search-name.js';
import { CHARACTERS_COLLECTION } from '../src/database/collections.js';
import { MongoService } from '../src/database/mongo.service.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { expectInvariants } from './support/invariants.js';
import { World } from './support/world.js';

/**
 * Name search, as the backend runs it: the query folded the same way the name
 * was, then an anchored prefix on `searchName`.
 *
 * Kept here because the reader lives in another application. This pins the two
 * things it depends on: that every spelling of a name is found by the plain
 * one, and that the query is answered from the index rather than by scanning.
 */
describe('name search', () => {
  let harness: TestApp;
  let db: Db;

  const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const search = (query: string) =>
    db
      .collection(CHARACTERS_COLLECTION)
      .find({ searchName: { $regex: `^${escapeRegex(searchNameOf(query))}` } })
      .limit(100);

  beforeAll(async () => {
    const world = World.seed({ regions: ['us'], players: 40, seed: 31 });
    const names = ['Bìbà', 'Biba', 'BIBAstrasz', 'Bob', 'Ærøn'];
    [...world.players.values()].slice(0, names.length).forEach((player, index) => {
      player.name = names[index]!;
    });

    harness = await bootTestApp(world);
    db = harness.app.get(MongoService).db;
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('finds every spelling of a name from the plain one', async () => {
    const found = (await search('biba').toArray()).map((doc) => doc.characterName).sort();

    expect(found).toEqual(['BIBAstrasz', 'Biba', 'Bìbà']);
  });

  it('folds the query too, so an accented query finds the plain name', async () => {
    const found = (await search('BÍB').toArray()).map((doc) => doc.characterName).sort();

    expect(found).toEqual(['BIBAstrasz', 'Biba', 'Bìbà']);
    expect((await search('aeron').toArray()).map((doc) => doc.characterName)).toEqual(['Ærøn']);
  });

  it('answers the prefix from the index, reading only the matching keys', async () => {
    const plan = await search('biba').explain('executionStats');

    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('character_search');
    expect(plan.executionStats.totalKeysExamined).toBeLessThanOrEqual(4);
    expect(plan.executionStats.totalDocsExamined).toBe(3);
  });

  it('keeps every stored name folded', async () => {
    await expectInvariants(db);
  });
});
