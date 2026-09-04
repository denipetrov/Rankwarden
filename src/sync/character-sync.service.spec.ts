import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { CharacterRepository } from '../leaderboard/character.repository.js';
import { RatingRepository } from '../leaderboard/rating.repository.js';
import { CharacterSyncService } from './character-sync.service.js';
import { characterSyncSchema } from './dto/character-sync.dto.js';

const input = (brackets: Record<string, unknown>) =>
  characterSyncSchema.parse({
    seasonId: 42,
    region: 'eu',
    characterId: 1,
    characterName: 'Warden',
    realmId: 60,
    realmSlug: 'tarren-mill',
    faction: 'HORDE',
    brackets,
  });

const stats = (rating: number) => ({ rank: 1, rating, played: 10, won: 6, lost: 4 });

describe('CharacterSyncService', () => {
  const updateCharacter = vi.fn();
  const replaceForCharacter = vi.fn();
  let coordinator: IngestionCoordinator;
  let service: CharacterSyncService;

  beforeEach(async () => {
    vi.clearAllMocks();
    updateCharacter.mockResolvedValue({ matched: true });
    replaceForCharacter.mockResolvedValue({ written: 1, removed: 0 });
    coordinator = new IngestionCoordinator();

    const moduleRef = await Test.createTestingModule({
      providers: [
        CharacterSyncService,
        { provide: IngestionCoordinator, useValue: coordinator },
        { provide: CharacterRepository, useValue: { updateCharacter } },
        { provide: RatingRepository, useValue: { replaceForCharacter } },
      ],
    }).compile();

    service = moduleRef.get(CharacterSyncService);
  });

  it('refuses to write while a ladder sweep is running', async () => {
    await coordinator.duringSweep(async () => {
      await expect(service.sync(input({ '3v3': stats(2000) }))).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    expect(updateCharacter).not.toHaveBeenCalled();
    expect(replaceForCharacter).not.toHaveBeenCalled();
  });

  it('writes again once the sweep has finished', async () => {
    await coordinator.duringSweep(async () => {});
    await service.sync(input({ '3v3': stats(2000) }));

    expect(updateCharacter).toHaveBeenCalledOnce();
  });

  it('does not create a character the collection has never seen', async () => {
    updateCharacter.mockResolvedValue({ matched: false });

    await expect(service.sync(input({ '3v3': stats(2000) }))).rejects.toBeInstanceOf(
      NotFoundException,
    );

    // Crucially it must not leave rating rows behind for a character that is
    // not in `characters`.
    expect(replaceForCharacter).not.toHaveBeenCalled();
  });

  it('derives the ratings mirror from the brackets it was given', async () => {
    await service.sync(input({ '3v3': stats(2000), 'shuffle-mage-fire': stats(2688) }));

    expect(updateCharacter).toHaveBeenCalledWith(
      expect.objectContaining({ ratings: { '3v3': 2000, 'shuffle-mage-fire': 2688 } }),
      undefined,
    );
  });

  it('routes each bracket to its own family collection', async () => {
    await service.sync(input({ '3v3': stats(2000), 'shuffle-mage-fire': stats(2688) }));

    expect(replaceForCharacter).toHaveBeenCalledWith('3v3', 42, 'eu', 1, [
      expect.objectContaining({ bracket: '3v3' }),
    ]);
    expect(replaceForCharacter).toHaveBeenCalledWith('shuffle', 42, 'eu', 1, [
      expect.objectContaining({ bracket: 'shuffle-mage-fire' }),
    ]);
    // Families the payload says nothing about are emptied for this character.
    expect(replaceForCharacter).toHaveBeenCalledWith('2v2', 42, 'eu', 1, []);
    expect(replaceForCharacter).toHaveBeenCalledWith('blitz', 42, 'eu', 1, []);
  });

  it('drops aggregate brackets the sweep does not store either', async () => {
    const result = await service.sync(
      input({ 'shuffle-overall': stats(2454), 'shuffle-mage-fire': stats(2688) }),
    );

    expect(result.ignoredBrackets).toEqual(['shuffle-overall']);
    expect(updateCharacter).toHaveBeenCalledWith(
      expect.objectContaining({ ratings: { 'shuffle-mage-fire': 2688 } }),
      undefined,
    );
  });

  it('rejects an empty bracket set rather than blanking the record', async () => {
    // A blanked record would be deleted by the next sweep's unranked cleanup.
    await expect(service.sync(input({}))).rejects.toBeInstanceOf(BadRequestException);

    expect(updateCharacter).not.toHaveBeenCalled();
    expect(replaceForCharacter).not.toHaveBeenCalled();
  });

  it('rejects a payload made up entirely of brackets it does not store', async () => {
    await expect(service.sync(input({ 'shuffle-overall': stats(2454) }))).rejects.toBeInstanceOf(
      BadRequestException,
    );

    expect(updateCharacter).not.toHaveBeenCalled();
  });

  it('stamps a fetchedAt on brackets that arrive without one', async () => {
    await service.sync(input({ '3v3': stats(2000) }));

    const [document] = updateCharacter.mock.calls[0];
    expect(document.brackets['3v3'].fetchedAt).toBeInstanceOf(Date);
  });

  it('passes only the profile fields the payload mentioned', async () => {
    const payload = characterSyncSchema.parse({
      ...input({ '3v3': stats(2000) }),
      profile: {
        race: { id: 10, name: 'Blood Elf' },
        class: { id: 2, name: 'Paladin' },
        level: 90,
      },
    });

    await service.sync(payload);

    const [, profile] = updateCharacter.mock.calls[0];
    expect(profile).toEqual({
      race: { id: 10, name: 'Blood Elf' },
      class: { id: 2, name: 'Paladin' },
      level: 90,
    });
    // Fields the caller never mentioned must not arrive as nulls that would
    // overwrite stored data.
    expect(Object.keys(profile)).not.toContain('spec');
    expect(Object.keys(profile)).not.toContain('talentLoadouts');
  });

  it('forwards an explicit null so a caller can clear a field', async () => {
    const payload = characterSyncSchema.parse({
      ...input({ '3v3': stats(2000) }),
      profile: { title: null },
    });

    await service.sync(payload);

    const [, profile] = updateCharacter.mock.calls[0];
    expect(profile).toEqual({ title: null });
  });
});
