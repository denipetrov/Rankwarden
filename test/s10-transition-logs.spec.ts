import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoggerService } from '@nestjs/common';
import type { Db } from 'mongodb';

import { CHARACTERS_COLLECTION } from '../src/leaderboard/entities/character.entity.js';
import { RATING_COLLECTIONS } from '../src/leaderboard/entities/rating.entity.js';
import { SPEC_REPRESENTATION_COLLECTION } from '../src/representation/entities/spec-representation.entity.js';
import { LeaderboardService } from '../src/leaderboard/leaderboard.service.js';
import { SeasonService } from '../src/season/season.service.js';
import { SeasonTransitionService } from '../src/season/season-transition.service.js';
import { MongoService } from '../src/database/mongo.service.js';
import { bootTestApp, type TestApp } from './support/app.js';
import { CORE_BRACKETS, World } from './support/world.js';

const SEASON = 42;
const NEXT = 43;

class CapturingLogger implements LoggerService {
  readonly lines: { level: string; message: string }[] = [];

  private push(level: string, message: unknown) {
    this.lines.push({ level, message: typeof message === 'string' ? message : String(message) });
  }

  log = (m: unknown) => this.push('log', m);
  error = (m: unknown) => this.push('error', m);
  warn = (m: unknown) => this.push('warn', m);
  debug = (m: unknown) => this.push('debug', m);
  verbose = (m: unknown) => this.push('verbose', m);

  of(level: string) {
    return this.lines.filter((line) => line.level === level);
  }
}

/**
 * S10.12 / S10.13 — the two log lines an operator greps for once a season, and
 * the only record of an irreversible delete.
 *
 * Both are asserted at `warn`, because that is the level a production
 * deployment realistically runs at and neither line is worth having if it is
 * only visible at `debug`.
 */
describe('S10 — season transition logging', () => {
  const ENV = {
    SEASON_REFRESH_ENABLED: 'true',
    SEASON_PURGE_DRY_RUN: 'false',
    SEASON_PURGE_REQUIRE_ARCHIVE: 'false',
  };

  const logger = new CapturingLogger();
  let harness: TestApp;
  let db: Db;
  let world: World;

  const warnings = (pattern: RegExp) =>
    logger.of('warn').filter((line) => pattern.test(line.message));

  beforeAll(async () => {
    world = World.seed({
      regions: ['us'],
      players: 30,
      seed: 1012,
      season: SEASON,
      brackets: [...CORE_BRACKETS],
    });
    for (const [index, player] of [...world.players.values()].entries()) {
      world.setRating(player.id, '3v3', 1700 + index);
    }

    harness = await bootTestApp(world, ENV, undefined, logger);
    db = harness.app.get(MongoService).db;
    await harness.settle();
    expect(await harness.app.get(LeaderboardService).sweep()).not.toBeNull();
  });

  afterAll(async () => {
    await db?.dropDatabase();
    await harness?.close();
  });

  it('S10.12 — a season ending is one warn line naming the region and the season', async () => {
    world.endSeason('us', new Date('2026-09-01T05:00:00.000Z'));
    await harness.app.get(SeasonService).refresh('us');

    const ended = warnings(/has ended in/);

    expect(ended.length, 'exactly one line, at warn').toBe(1);
    expect(ended[0].message).toContain('us');
    expect(ended[0].message).toContain(String(SEASON));
    // A stable token rather than a sentence shape: an operator has to be able
    // to find this without knowing how it is phrased this month.
    expect(ended[0].message).toMatch(/has ended/);
  });

  it('S10.12b — and a rollover is a different line, naming both seasons', async () => {
    world.rollover('us', NEXT, new Date('2026-09-02T15:00:00.000Z'));
    for (const [index, player] of [...world.players.values()].entries()) {
      world.setRating(player.id, '3v3', 1800 + index);
    }
    await harness.app.get(SeasonService).refresh('us');
    await harness.app.get(LeaderboardService).sweep();

    const rollovers = warnings(/Season rollover in/);

    expect(rollovers.length).toBe(1);
    expect(rollovers[0].message).toContain(String(SEASON));
    expect(rollovers[0].message).toContain(String(NEXT));
    expect(rollovers[0].message).toContain('us');

    // The two are distinguishable by token, so a dashboard can count them
    // separately without regex-matching prose.
    expect(warnings(/has ended in/).length, 'and the ending line is not repeated').toBe(1);
  });

  it('S10.13 — a purge logs what it removed, by collection', async () => {
    const before = {
      characters: await db
        .collection(CHARACTERS_COLLECTION)
        .countDocuments({ seasonId: SEASON, region: 'us' }),
      rows: await db
        .collection(RATING_COLLECTIONS['3v3'])
        .countDocuments({ seasonId: SEASON, region: 'us' }),
    };
    expect(before.characters, 'there is something to retire').toBeGreaterThan(0);

    const outcome = await harness.app.get(SeasonTransitionService).run();
    expect(outcome.purged.length).toBe(1);

    const retired = warnings(/Retired season/);
    expect(retired.length, 'one line per season and region').toBe(1);

    // This is an irreversible delete across three collections; the log line is
    // the only record of what went, so it names each one and its count.
    const message = retired[0].message;
    expect(message).toContain(`season ${SEASON} us`);
    expect(message).toContain(`${before.characters} ${CHARACTERS_COLLECTION}`);
    expect(message).toContain(`${before.rows} ${RATING_COLLECTIONS['3v3']}`);
    expect(message.split(String.fromCharCode(10)), 'on one line').toHaveLength(1);

    // A collection that had nothing is left out rather than logged as a zero,
    // so the line stays readable at eighty-three brackets' worth of families.
    expect(message).not.toContain(SPEC_REPRESENTATION_COLLECTION);
  });

  it('S10.13b — and says nothing was there when a season is already empty', async () => {
    // The counts come from the delete result, so a second run has to be able to
    // say "nothing" rather than printing an empty list.
    const { purged } = await harness.app.get(SeasonTransitionService).run();

    expect(purged, 'already retired, so nothing is offered again').toEqual([]);
    expect(warnings(/Retired season/).length, 'and nothing is logged twice').toBe(1);
  });
});
