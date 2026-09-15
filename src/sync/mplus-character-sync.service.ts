import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';

import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import {
  mplusCharacterKey,
  type MplusCharacterDocument,
  type MplusCharacterProfile,
  type MplusDungeonRun,
} from '../mplus/entities/mplus-character.entity.js';
import { MplusRepository } from '../mplus/mplus.repository.js';
import type { MplusCharacterSyncInput } from './dto/mplus-character-sync.dto.js';

export interface MplusCharacterSyncResult {
  key: string;
  /** Runs supplied, and how many of them were new dungeons for this character. */
  dungeonRuns: number;
  addedDungeons: number;
  /** The recomputed stats, so a caller sees what the merge actually settled on. */
  mythicScore: number;
  dungeonsCovered: number;
}

/**
 * Updates one stored Mythic+ character from a record pushed in by the search API.
 *
 * The Mythic+ counterpart to `CharacterSyncService`, and it follows the same
 * three rules: it never creates a character, it refuses to interleave with the
 * job that owns the same documents, and it recomputes every derived field rather
 * than trusting the caller for it.
 *
 * It differs in one way worth knowing at a call site. The PvP endpoint treats
 * `brackets` as authoritative for every ladder at once, so omitting one deletes
 * it. `dungeonRuns` here is **merged** instead, because a Mythic+ score cannot
 * fall — see `MplusCharacterDocument`. Omitting a dungeon therefore leaves it
 * alone rather than removing it, and there is no payload that lowers a score.
 */
@Injectable()
export class MplusCharacterSyncService {
  private readonly logger = new Logger(MplusCharacterSyncService.name);

  constructor(
    private readonly repository: MplusRepository,
    private readonly coordinator: IngestionCoordinator,
  ) {}

  async sync(input: MplusCharacterSyncInput): Promise<MplusCharacterSyncResult> {
    // A pass rewrites these same documents, and its own write is a
    // read-merge-write; letting a push land between the two halves would lose
    // whichever arrived first.
    if (this.coordinator.isMplusActive) {
      throw new ConflictException('A Mythic+ pass is in progress; retry once it has finished.');
    }

    const key = mplusCharacterKey(input.region, input.realmSlug, input.characterName);
    const updatedAt = new Date();

    // Only fields the caller actually mentioned. `key`, `season` and `region`
    // are identity and are never rewritten by an update that found the document
    // through them.
    const fields: Partial<MplusCharacterDocument> = {
      characterName: input.characterName,
      nameKey: input.characterName.toLowerCase(),
      updatedAt,
    };

    if (input.seasonId !== undefined) fields.seasonId = input.seasonId;
    if (input.rioCharacterId !== undefined) fields.rioCharacterId = input.rioCharacterId;
    if (input.realmId !== undefined) fields.realmId = input.realmId;
    if (input.realmName !== undefined) fields.realmName = input.realmName;
    if (input.faction !== undefined) fields.faction = input.faction;

    const result = await this.repository.syncCharacter(
      input.season,
      key,
      fields,
      (input.profile ?? {}) as Partial<MplusCharacterProfile>,
      input.dungeonRuns as MplusDungeonRun[],
    );

    if (!result.matched) {
      throw new NotFoundException(`No Mythic+ character ${key} in season ${input.season}.`);
    }

    this.logger.log(
      `Synced Mythic+ ${key}: ${input.dungeonRuns.length} run(s) in, ` +
        `${result.added} new dungeon(s), score now ${result.mythicScore} ` +
        `over ${result.dungeonsCovered} dungeon(s)`,
    );

    return {
      key,
      dungeonRuns: input.dungeonRuns.length,
      addedDungeons: result.added,
      mythicScore: result.mythicScore,
      dungeonsCovered: result.dungeonsCovered,
    };
  }
}
