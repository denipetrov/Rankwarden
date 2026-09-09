import { describe, expect, it, vi } from 'vitest';
import { MongoBulkWriteError } from 'mongodb';

import { CharacterRepository } from './character.repository.js';
import type { MongoService } from '../database/mongo.service.js';
import type { CharacterBracketUpdate } from './leaderboard.mapper.js';

/**
 * §9.7 — the upsert replay path.
 *
 * Two brackets of the same region are swept concurrently and now land on the
 * same character document, so an upsert can lose the race on the identity index
 * and come back with E11000. The document exists by the time the error arrives,
 * so replaying just the losing operations settles them as plain updates.
 *
 * Tested here rather than against a real database because the race is a narrow
 * window in the server: an integration test that happens not to hit it passes
 * for the wrong reason and quietly stops covering anything.
 */
describe('CharacterRepository — upsert races on identity', () => {
  const update = (characterId: number, bracket: string): CharacterBracketUpdate =>
    ({
      seasonId: 42,
      region: 'us',
      characterId,
      characterName: `Char${characterId}`,
      realmId: 60,
      realmSlug: 'tarren-mill',
      faction: 'HORDE',
      bracket,
      stats: { rank: 1, rating: 1800, played: 10, won: 6, lost: 4, fetchedAt: new Date() },
    }) as CharacterBracketUpdate;

  /** A `MongoBulkWriteError` as the driver reports a lost upsert race. */
  const duplicateKeyError = (indexes: number[], applied: number) => {
    const error = Object.create(MongoBulkWriteError.prototype) as MongoBulkWriteError;

    Object.assign(error, {
      message: 'E11000 duplicate key error collection: characters index: character_identity',
      writeErrors: indexes.map((index) => ({ index, code: 11000, errmsg: 'E11000' })),
      result: { upsertedCount: applied, modifiedCount: 0 },
    });

    return error;
  };

  const repositoryOver = (bulkWrite: ReturnType<typeof vi.fn>) => {
    const collection = { bulkWrite, createIndexes: vi.fn(), listIndexes: vi.fn() };

    return new CharacterRepository({ collection: () => collection } as unknown as MongoService);
  };

  it('replays only the operations that lost the race', async () => {
    const bulkWrite = vi
      .fn()
      // Three of five upserts collided; the other two were applied.
      .mockRejectedValueOnce(duplicateKeyError([1, 2, 4], 2))
      .mockResolvedValueOnce({ upsertedCount: 0, modifiedCount: 3 });

    const repository = repositoryOver(bulkWrite);
    const written = await repository.upsertBracketEntries(
      [1, 2, 3, 4, 5].map((id) => update(id, '3v3')),
    );

    expect(bulkWrite, 'one attempt, then one replay').toHaveBeenCalledTimes(2);

    // The replay carries exactly the losing operations, in their original
    // order — not the whole chunk, which would redo work that already landed.
    const replayed = bulkWrite.mock.calls[1][0] as {
      updateOne: { filter: { characterId: number } };
    }[];
    expect(replayed.map((operation) => operation.updateOne.filter.characterId)).toEqual([2, 3, 5]);

    // Both halves count: what the first attempt applied, plus the replay.
    expect(written, '2 from the first attempt and 3 from the replay').toBe(5);
  });

  it('does not replay a second time, so a persistent conflict cannot loop', async () => {
    const bulkWrite = vi
      .fn()
      .mockRejectedValueOnce(duplicateKeyError([0], 0))
      .mockRejectedValueOnce(duplicateKeyError([0], 0));

    const repository = repositoryOver(bulkWrite);

    await expect(repository.upsertBracketEntries([update(1, '3v3')])).rejects.toThrow(/E11000/);
    expect(bulkWrite).toHaveBeenCalledTimes(2);
  });

  it('rethrows when anything other than a lost race is mixed in', async () => {
    const error = duplicateKeyError([0], 0);
    // A document-too-large sitting alongside the duplicate key. Replaying would
    // swallow it, and the entry would go missing with nothing reporting why.
    Object.assign(error, {
      writeErrors: [
        { index: 0, code: 11000, errmsg: 'E11000' },
        { index: 1, code: 2, errmsg: 'BadValue' },
      ],
    });

    const bulkWrite = vi.fn().mockRejectedValueOnce(error);
    const repository = repositoryOver(bulkWrite);

    await expect(
      repository.upsertBracketEntries([update(1, '3v3'), update(2, '3v3')]),
    ).rejects.toBe(error);
    expect(bulkWrite, 'no replay was attempted').toHaveBeenCalledTimes(1);
  });
});
