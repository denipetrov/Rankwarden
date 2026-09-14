import { describe, expect, it } from 'vitest';

import {
  mythicPlusRankingSchema,
  type MythicPlusRanking,
} from '../raiderio/schemas/mythic-plus-runs.schema.js';
import { MplusCharacterAccumulator, isAnonymised, toRunDocument } from './mplus.mapper.js';

/**
 * Shaped after a real `/mythic-plus/runs` entry, trimmed to the fields that
 * matter here. Parsed through the real schema so a change that breaks the
 * payload contract fails in this file rather than in production.
 */
function ranking(overrides: {
  runId: number;
  rank?: number;
  score: number;
  dungeonId: number;
  dungeonName?: string;
  level?: number;
  roster: {
    id: number;
    name: string;
    realm?: string;
    wowRealmId?: number | null;
    region?: string;
    specId?: number | null;
    role?: string;
    anonymised?: boolean;
    /** Drops the explicit `anonymized` flags, leaving only the sentinel shape. */
    flaglessAnon?: boolean;
    loadout?: string | null;
  }[];
}): MythicPlusRanking {
  return mythicPlusRankingSchema.parse({
    rank: overrides.rank ?? 1,
    score: overrides.score,
    run: {
      keystone_run_id: overrides.runId,
      season: 'season-mn-2',
      status: 'finished',
      dungeon: {
        id: overrides.dungeonId,
        name: overrides.dungeonName ?? 'Temple of Sethraliss',
        slug: 'temple-of-sethraliss',
        short_name: 'TOS',
      },
      mythic_level: overrides.level ?? 22,
      clear_time_ms: 1_906_389,
      keystone_time_ms: 1_920_999,
      completed_at: '2026-09-13T08:00:10.000Z',
      num_chests: 1,
      time_remaining_ms: 14_610,
      weekly_modifiers: [
        {
          id: 9,
          name: 'Tyrannical',
          slug: 'tyrannical',
          description: 'Bosses have 25% more health.',
        },
        { id: 10, name: 'Fortified', slug: 'fortified' },
      ],
      faction: 'alliance',
      roster: overrides.roster.map((member) => ({
        character: {
          id: member.id,
          persona_id: 0,
          name: member.name,
          class: { id: 8, name: 'Mage', slug: 'mage' },
          race: { id: 3, name: 'Dwarf', slug: 'dwarf' },
          spec:
            member.specId === null
              ? null
              : { id: member.specId ?? 62, name: 'Arcane', slug: 'arcane' },
          faction: 'alliance',
          level: 90,
          realm:
            member.anonymised || member.flaglessAnon
              ? // The anonymised realm really does omit wowRealmId, altName,
                // locale and realmType. A schema that required any of them would
                // fail the whole page.
                {
                  id: 0,
                  name: 'Anonymous',
                  slug: 'anonymous',
                  altSlug: 'anonymous',
                  ...(member.flaglessAnon ? {} : { anonymized: true }),
                }
              : {
                  id: 100,
                  name: 'Stormrage',
                  slug: member.realm ?? 'stormrage',
                  wowRealmId: member.wowRealmId === null ? undefined : (member.wowRealmId ?? 60),
                },
          region: { name: 'United States', slug: member.region ?? 'us', short_name: 'US' },
          ...(member.anonymised ? { anonymized: true } : {}),
        },
        role: member.role ?? 'dps',
        loadout: member.loadout ?? 'CODE',
      })),
    },
  });
}

describe('isAnonymised', () => {
  it('catches the explicit flag', () => {
    const anon = ranking({
      runId: 1,
      score: 100,
      dungeonId: 9527,
      roster: [{ id: 0, name: 'Anon12627389', anonymised: true }],
    });

    expect(isAnonymised(anon.run.roster[0])).toBe(true);
  });

  /**
   * The payload sets all three signals today. This asserts the two that are not
   * the flag, so dropping `anonymized` upstream degrades into nothing rather
   * than folding every anonymous player in a region into one document.
   */
  it('catches the zero id and the placeholder realm without either flag', () => {
    const anon = ranking({
      runId: 1,
      score: 100,
      dungeonId: 9527,
      roster: [{ id: 0, name: 'Anon12627389', flaglessAnon: true }],
    });

    expect(anon.run.roster[0].character.anonymized, 'no flag in this payload').toBeUndefined();
    expect(anon.run.roster[0].character.realm.anonymized).toBeUndefined();
    expect(isAnonymised(anon.run.roster[0])).toBe(true);
  });

  it('leaves an ordinary character alone', () => {
    const normal = ranking({
      runId: 1,
      score: 100,
      dungeonId: 9527,
      roster: [{ id: 228420218, name: 'Exxibae' }],
    });

    expect(isAnonymised(normal.run.roster[0])).toBe(false);
  });
});

describe('toRunDocument', () => {
  const fetchedAt = new Date('2026-09-14T00:00:00.000Z');

  it('stores affix ids rather than repeating their descriptions', () => {
    const document = toRunDocument(
      ranking({ runId: 11_626_563, score: 515.3, dungeonId: 9527, roster: [{ id: 1, name: 'A' }] }),
      'us',
      fetchedAt,
    );

    expect(document.affixIds).toEqual([9, 10]);
    expect(JSON.stringify(document)).not.toContain('Bosses have 25% more health');
  });

  it('keeps anonymised members in the roster but out of the lookup keys', () => {
    const document = toRunDocument(
      ranking({
        runId: 2,
        score: 400,
        dungeonId: 9527,
        roster: [
          { id: 228420218, name: 'Exxibae' },
          { id: 0, name: 'Anon12627389', anonymised: true },
        ],
      }),
      'us',
      fetchedAt,
    );

    expect(document.roster, 'a five-person run listing four would be wrong').toHaveLength(2);
    expect(document.roster[1].anonymized).toBe(true);
    expect(document.roster[1].realmId, 'the anonymous realm carries no wowRealmId').toBeNull();
    expect(document.rosterKeys).toEqual(['us/stormrage/exxibae']);
  });

  it('carries Blizzard realm ids through and Raider.io character ids as-is', () => {
    const document = toRunDocument(
      ranking({
        runId: 3,
        score: 400,
        dungeonId: 9527,
        roster: [{ id: 228420218, name: 'Exxibae', wowRealmId: 60 }],
      }),
      'us',
      fetchedAt,
    );

    expect(document.roster[0].realmId, "wowRealmId is Blizzard's").toBe(60);
    expect(document.roster[0].rioCharacterId, "but the character id is Raider.io's").toBe(
      228420218,
    );
  });
});

describe('MplusCharacterAccumulator', () => {
  const at = new Date('2026-09-14T00:00:00.000Z');

  it('sums the best run per dungeon, not every run', () => {
    const accumulator = new MplusCharacterAccumulator('season-mn-2', 18, 'us');
    const roster = [{ id: 1, name: 'Exxibae' }];

    // Two runs of the same dungeon: only the higher score counts.
    accumulator.add(ranking({ runId: 1, score: 500, dungeonId: 9527, roster }), at);
    accumulator.add(ranking({ runId: 2, score: 480, dungeonId: 9527, roster }), at);
    // A different dungeon adds to the total.
    accumulator.add(ranking({ runId: 3, score: 300, dungeonId: 9526, roster }), at);

    const [character] = accumulator.drain();

    expect(character.mythicScore).toBe(800);
    expect(character.dungeonsCovered).toBe(2);
    expect(character.dungeonRuns.map((run) => run.keystoneRunId)).toEqual([1, 3]);
  });

  it('rounds away the float noise eight summed scores produce', () => {
    const accumulator = new MplusCharacterAccumulator('season-mn-2', 18, 'us');
    const roster = [{ id: 1, name: 'Exxibae' }];

    for (const [index, score] of [515.3, 502.6, 498.1, 471.2].entries()) {
      accumulator.add(ranking({ runId: index, score, dungeonId: 9520 + index, roster }), at);
    }

    const [character] = accumulator.drain();

    expect(character.mythicScore).toBe(1987.2);
  });

  it('keeps the first of two equal scores, which is the better-ranked run', () => {
    const accumulator = new MplusCharacterAccumulator('season-mn-2', 18, 'us');
    const roster = [{ id: 1, name: 'Exxibae' }];

    accumulator.add(ranking({ runId: 10, rank: 1, score: 500, dungeonId: 9527, roster }), at);
    accumulator.add(ranking({ runId: 11, rank: 2, score: 500, dungeonId: 9527, roster }), at);

    expect(accumulator.drain()[0].dungeonRuns[0].keystoneRunId).toBe(10);
  });

  it('keys on realm and name, so a case difference is the same character', () => {
    const accumulator = new MplusCharacterAccumulator('season-mn-2', 18, 'us');

    accumulator.add(
      ranking({ runId: 1, score: 500, dungeonId: 9527, roster: [{ id: 1, name: 'Exxibae' }] }),
      at,
    );
    accumulator.add(
      ranking({ runId: 2, score: 300, dungeonId: 9526, roster: [{ id: 1, name: 'exxibae' }] }),
      at,
    );

    expect(accumulator.size).toBe(1);
    expect(accumulator.drain()[0].dungeonsCovered).toBe(2);
  });

  /**
   * The trap this collection exists to avoid. Every anonymised character
   * carries `id: 0` and the placeholder realm, so keying on either would fold
   * all of them into one document holding one player's runs under another
   * player's name.
   */
  it('never folds anonymised characters together', () => {
    const accumulator = new MplusCharacterAccumulator('season-mn-2', 18, 'us');

    accumulator.add(
      ranking({
        runId: 1,
        score: 500,
        dungeonId: 9527,
        roster: [
          { id: 0, name: 'Anon12627389', anonymised: true },
          { id: 0, name: 'Anoncd81ecc', anonymised: true },
          // The same sentinel shape with neither flag set, so the fold is
          // proven to rest on more than a field Raider.io could drop.
          { id: 0, name: 'Anon12625f25', flaglessAnon: true },
          { id: 228420218, name: 'Exxibae' },
        ],
      }),
      at,
    );

    const characters = accumulator.drain();

    expect(characters).toHaveLength(1);
    expect(characters[0].characterName).toBe('Exxibae');
  });

  it('separates the same name on two realms', () => {
    const accumulator = new MplusCharacterAccumulator('season-mn-2', 18, 'us');

    accumulator.add(
      ranking({
        runId: 1,
        score: 500,
        dungeonId: 9527,
        roster: [
          { id: 1, name: 'Exxibae', realm: 'stormrage' },
          { id: 2, name: 'Exxibae', realm: 'illidan' },
        ],
      }),
      at,
    );

    expect(accumulator.size).toBe(2);
  });

  it('records the spec and role each run was played on', () => {
    const accumulator = new MplusCharacterAccumulator('season-mn-2', 18, 'us');

    accumulator.add(
      ranking({
        runId: 1,
        score: 500,
        dungeonId: 9527,
        roster: [{ id: 1, name: 'Exxibae', specId: 65, role: 'healer' }],
      }),
      at,
    );

    const [character] = accumulator.drain();

    expect(character.dungeonRuns[0].specId).toBe(65);
    expect(character.dungeonRuns[0].role).toBe('healer');
    expect(character.characterType).toBe('M+');
  });

  it('drains empty, so a second region does not inherit the first', () => {
    const accumulator = new MplusCharacterAccumulator('season-mn-2', 18, 'us');

    accumulator.add(
      ranking({ runId: 1, score: 500, dungeonId: 9527, roster: [{ id: 1, name: 'Exxibae' }] }),
      at,
    );

    expect(accumulator.drain()).toHaveLength(1);
    expect(accumulator.drain()).toHaveLength(0);
  });
});
