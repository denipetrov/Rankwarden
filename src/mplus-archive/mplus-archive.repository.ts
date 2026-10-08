import { Injectable } from '@nestjs/common';
import type { AnyBulkWriteOperation } from 'mongodb';

import { MongoService } from '../database/mongo.service.js';
import type { RaiderIoRegion } from '../raiderio/raiderio.constants.js';
import {
  type MplusArchiveCharacterDocument,
  type MplusArchiveRunDocument,
} from './entities/mplus-archive.entity.js';
import {
  MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
  MPLUS_ARCHIVE_RUNS_COLLECTION,
} from '../database/collections.js';

const BULK_CHUNK_SIZE = 1_000;

/**
 * The archived runs and characters.
 *
 * The season catalogue, and the marker that says a season is archived, live in
 * `MplusCatalogueRepository`. The order between the two still matters and is
 * the service's to keep: a season's marker is written only after its rows, so a
 * crash between the two leaves rows without a marker rather than a marker
 * claiming rows that are not there.
 */
@Injectable()
export class MplusArchiveRepository {
  constructor(private readonly mongo: MongoService) {}

  private get runs() {
    return this.mongo.collection<MplusArchiveRunDocument>(MPLUS_ARCHIVE_RUNS_COLLECTION);
  }

  private get characters() {
    return this.mongo.collection<MplusArchiveCharacterDocument>(
      MPLUS_ARCHIVE_CHARACTERS_COLLECTION,
    );
  }

  /** Upserts archived runs by identity. Idempotent, so a retried season rewrites. */
  async upsertRuns(runs: readonly MplusArchiveRunDocument[]): Promise<number> {
    let written = 0;

    for (let offset = 0; offset < runs.length; offset += BULK_CHUNK_SIZE) {
      const chunk = runs.slice(offset, offset + BULK_CHUNK_SIZE);
      const operations = chunk.map<AnyBulkWriteOperation<MplusArchiveRunDocument>>((run) => ({
        updateOne: {
          filter: { season: run.season, keystoneRunId: run.keystoneRunId },
          update: { $set: run },
          upsert: true,
        },
      }));

      const result = await this.runs.bulkWrite(operations, { ordered: false });
      written += result.upsertedCount + result.modifiedCount;
    }

    return written;
  }

  /**
   * Upserts archived characters by identity.
   *
   * A plain `$set`, with none of the live collection's per-dungeon merge: a
   * finished season cannot gain a run, and the document is computed from one
   * complete read of the season, so there is nothing stored worth keeping over
   * it.
   */
  async upsertCharacters(characters: readonly MplusArchiveCharacterDocument[]): Promise<number> {
    let written = 0;

    for (let offset = 0; offset < characters.length; offset += BULK_CHUNK_SIZE) {
      const chunk = characters.slice(offset, offset + BULK_CHUNK_SIZE);
      const operations = chunk.map<AnyBulkWriteOperation<MplusArchiveCharacterDocument>>(
        (character) => ({
          updateOne: {
            filter: { season: character.season, key: character.key },
            update: { $set: character },
            upsert: true,
          },
        }),
      );

      const result = await this.characters.bulkWrite(operations, { ordered: false });
      written += result.upsertedCount + result.modifiedCount;
    }

    return written;
  }

  /** What is stored for a season in one region, for adopting a region whose marker was lost. */
  async summariseStored(
    season: string,
    region: RaiderIoRegion,
  ): Promise<{ runs: number; characters: number }> {
    const [runs, characters] = await Promise.all([
      this.runs.countDocuments({ season, region }),
      this.characters.countDocuments({ season, region }),
    ]);

    return { runs, characters };
  }
}
