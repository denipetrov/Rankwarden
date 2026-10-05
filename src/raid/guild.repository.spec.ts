import { describe, expect, it, vi } from 'vitest';

import type { MongoService } from '../database/mongo.service.js';
import type { GuildDocument } from './entities/guild.entity.js';
import { GuildRepository } from './guild.repository.js';

const guild = (id: number): GuildDocument => ({
  id,
  name: `Guild ${id}`,
  faction: 'horde',
  logo: null,
  region: 'eu',
  realm: null,
  updatedAt: new Date('2026-10-02T12:00:00Z'),
});

/** What is known is set; what is not is written only for a guild that is new. */
const split = ({ logo, realm, ...known }: GuildDocument) => ({
  $set: known,
  $setOnInsert: { logo, realm },
});

function repositoryOver(bulkWrite: ReturnType<typeof vi.fn>) {
  return new GuildRepository({
    collection: () => ({ bulkWrite }),
  } as unknown as MongoService);
}

describe('GuildRepository.upsertGuilds', () => {
  it('writes each guild by id, field-level and unordered, and counts what changed', async () => {
    const bulkWrite = vi.fn(async () => ({ upsertedCount: 1, modifiedCount: 1 }));

    expect(await repositoryOver(bulkWrite).upsertGuilds([guild(1), guild(2)])).toBe(2);
    expect(bulkWrite).toHaveBeenCalledWith(
      [
        { updateOne: { filter: { id: 1 }, update: split(guild(1)), upsert: true } },
        { updateOne: { filter: { id: 2 }, update: split(guild(2)), upsert: true } },
      ],
      { ordered: false },
    );
  });

  it('never sets a field a description leaves out, so what was known is kept', async () => {
    const bulkWrite = vi.fn(async () => ({ upsertedCount: 0, modifiedCount: 1 }));
    const sparse = { ...guild(1), faction: null, region: null, logo: 'https://cdn/logo.png' };

    await repositoryOver(bulkWrite).upsertGuilds([sparse]);

    const [[operations]] = bulkWrite.mock.calls as unknown as [
      [{ updateOne: { update: { $set: object; $setOnInsert: object } } }[]],
    ];
    expect(operations[0].updateOne.update).toEqual({
      $set: { id: 1, name: 'Guild 1', logo: 'https://cdn/logo.png', updatedAt: sparse.updatedAt },
      $setOnInsert: { faction: null, region: null, realm: null },
    });
  });

  it('makes no write for no guilds', async () => {
    const bulkWrite = vi.fn();

    expect(await repositoryOver(bulkWrite).upsertGuilds([])).toBe(0);
    expect(bulkWrite).not.toHaveBeenCalled();
  });

  it('writes again when another board inserted the same guild first', async () => {
    // Two boards read at once both upsert a guild neither has seen: one insert
    // wins, the other is a duplicate key.
    const bulkWrite = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }))
      .mockResolvedValueOnce({ upsertedCount: 0, modifiedCount: 2 });

    expect(await repositoryOver(bulkWrite).upsertGuilds([guild(1), guild(2)])).toBe(2);
    expect(bulkWrite).toHaveBeenCalledTimes(2);
  });

  it('does not swallow any other failure, or a duplicate key twice', async () => {
    const gone = vi.fn().mockRejectedValue(new Error('mongo is gone'));
    await expect(repositoryOver(gone).upsertGuilds([guild(1)])).rejects.toThrow('mongo is gone');
    expect(gone).toHaveBeenCalledTimes(1);

    const twice = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }));
    await expect(repositoryOver(twice).upsertGuilds([guild(1)])).rejects.toThrow('E11000');
    expect(twice).toHaveBeenCalledTimes(2);
  });
});
