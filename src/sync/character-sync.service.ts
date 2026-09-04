import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import {
  isIngestableBracket,
  ratingFamilyOf,
  RATING_FAMILIES,
  type Bracket,
  type RatingFamily,
} from '../blizzard/blizzard.constants.js';
import { IngestionCoordinator } from '../common/ingestion-coordinator.service.js';
import { CharacterRepository } from '../leaderboard/character.repository.js';
import { RatingRepository } from '../leaderboard/rating.repository.js';
import type { CharacterBracketUpdate } from '../leaderboard/leaderboard.mapper.js';
import type { BracketStats } from '../leaderboard/entities/character.entity.js';
import type { CharacterSyncInput } from './dto/character-sync.dto.js';

export interface CharacterSyncResult {
  brackets: number;
  /** Brackets rejected because the sweep does not store them either. */
  ignoredBrackets: Bracket[];
  /** Rows written and removed in each family's ratings collection. */
  ratingRows: Record<RatingFamily, { written: number; removed: number }>;
}

/**
 * Writes a whole character record pushed in by the search API, keeping
 * `characters` and the two per-spec ratings collections consistent with it.
 *
 * The payload is authoritative for every bracket at once — unlike the sweep,
 * which sees one bracket at a time — so brackets missing from it are treated as
 * brackets the character has left, and their ratings rows are removed.
 */
@Injectable()
export class CharacterSyncService {
  private readonly logger = new Logger(CharacterSyncService.name);

  constructor(
    private readonly characters: CharacterRepository,
    private readonly ratings: RatingRepository,
    private readonly coordinator: IngestionCoordinator,
  ) {}

  async sync(input: CharacterSyncInput): Promise<CharacterSyncResult> {
    // A sweep is authoritative and rewrites these same documents; letting a
    // push interleave would produce a record half from each source.
    if (this.coordinator.isSweepActive) {
      throw new ConflictException('A ladder sweep is in progress; retry once it has finished.');
    }

    const updatedAt = new Date();
    const ignoredBrackets = Object.keys(input.brackets).filter(
      (bracket) => !isIngestableBracket(bracket),
    );

    const brackets: Record<string, BracketStats> = {};
    const ratings: Record<string, number> = {};

    for (const [bracket, stats] of Object.entries(input.brackets)) {
      if (!isIngestableBracket(bracket)) continue;

      brackets[bracket] = { ...stats, fetchedAt: stats.fetchedAt ?? updatedAt };
      ratings[bracket] = stats.rating;
    }

    // Accepting this would blank the character's ladder data, and the next
    // sweep's unranked cleanup would then delete the document outright. A caller
    // with nothing to say about a character should not be calling at all.
    if (Object.keys(brackets).length === 0) {
      throw new BadRequestException(
        ignoredBrackets.length > 0
          ? `No storable brackets in payload; ${ignoredBrackets.join(', ')} are not ingested.`
          : 'A character sync must carry at least one bracket.',
      );
    }

    const { matched } = await this.characters.updateCharacter(
      {
        seasonId: input.seasonId,
        region: input.region,
        characterId: input.characterId,
        characterName: input.characterName,
        realmId: input.realmId,
        realmSlug: input.realmSlug,
        faction: input.faction,
        brackets,
        ratings,
        updatedAt,
      },
      input.profile,
    );

    // Only characters some ladder already lists are tracked; creating one here
    // would fill the collection with players who hold no rating at all.
    if (!matched) {
      throw new NotFoundException(
        `No character ${input.characterId} in ${input.region} for season ${input.seasonId}.`,
      );
    }

    const ratingRows = await this.syncRatingRows(input, brackets);
    const totals = Object.values(ratingRows).reduce(
      (acc, row) => ({ written: acc.written + row.written, removed: acc.removed + row.removed }),
      { written: 0, removed: 0 },
    );

    this.logger.log(
      `Synced ${input.region}/${input.characterName} (${input.characterId}): ` +
        `${Object.keys(brackets).length} brackets, ` +
        `${totals.written} rating rows written, ${totals.removed} removed`,
    );

    return { brackets: Object.keys(brackets).length, ignoredBrackets, ratingRows };
  }

  private async syncRatingRows(input: CharacterSyncInput, brackets: Record<string, BracketStats>) {
    const byFamily = new Map<RatingFamily, CharacterBracketUpdate[]>(
      RATING_FAMILIES.map((family) => [family, []]),
    );

    for (const [bracket, stats] of Object.entries(brackets)) {
      const family = ratingFamilyOf(bracket);
      if (!family) continue;

      byFamily.get(family)?.push({
        seasonId: input.seasonId,
        region: input.region,
        characterId: input.characterId,
        characterName: input.characterName,
        realmId: input.realmId,
        realmSlug: input.realmSlug,
        faction: input.faction,
        bracket,
        stats,
      });
    }

    const results = await Promise.all(
      RATING_FAMILIES.map(async (family) => [
        family,
        await this.ratings.replaceForCharacter(
          family,
          input.seasonId,
          input.region,
          input.characterId,
          byFamily.get(family) ?? [],
        ),
      ]),
    );

    return Object.fromEntries(results) as Record<
      RatingFamily,
      { written: number; removed: number }
    >;
  }
}
