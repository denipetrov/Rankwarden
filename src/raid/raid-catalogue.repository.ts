import { Injectable } from '@nestjs/common';

import { MongoService } from '../database/mongo.service.js';
import { type RaidCatalogueDocument, type RaidDocument } from './entities/raid.entity.js';
import { RAIDS_COLLECTION } from '../database/collections.js';

/** The catalogue never reads a raid's boards: they are the bulk of the document. */
const WITHOUT_BOARDS = { projection: { guilds: 0, guildsRefusedAt: 0 } } as const;

/** A raid as a catalogue walk writes it: no boards, and listed. */
export type CataloguedRaid = Omit<RaidCatalogueDocument, 'unlistedAt' | 'guildsUpdatedAt'>;

/** Storage for the raid catalogue: one document per raid. */
@Injectable()
export class RaidCatalogueRepository {
  constructor(private readonly mongo: MongoService) {}

  private get raids() {
    return this.mongo.collection<RaidDocument>(RAIDS_COLLECTION);
  }

  /**
   * Writes raids by id. Field-level, so anything a later job stores on a raid
   * document is not erased by a refresh; and a raid listed again stops being
   * unlisted.
   */
  async upsertRaids(raids: readonly CataloguedRaid[]): Promise<number> {
    if (raids.length === 0) return 0;

    const result = await this.raids.bulkWrite(
      raids.map((raid) => ({
        updateOne: {
          filter: { id: raid.id },
          update: { $set: raid, $unset: { unlistedAt: '' } },
          upsert: true,
        },
      })),
      { ordered: false },
    );

    return result.upsertedCount + result.modifiedCount;
  }

  /**
   * Marks every raid a complete walk at `walkedAt` did not stamp as unlisted.
   * Returns how many were marked.
   */
  async markUnlisted(walkedAt: Date): Promise<number> {
    const result = await this.raids.updateMany(
      { catalogueUpdatedAt: { $lt: walkedAt }, unlistedAt: { $exists: false } },
      { $set: { unlistedAt: walkedAt } },
    );

    return result.modifiedCount;
  }

  /**
   * When the least recently refreshed listed raid was read, or null if none
   * ever was.
   *
   * The oldest, not the newest, so a walk that failed partway is due again at
   * once rather than reading as fresh for a whole TTL. Only raids the last
   * complete walk listed: one it no longer lists is never stamped again, and
   * would keep the catalogue due for ever.
   */
  async catalogueUpdatedAt(): Promise<Date | null> {
    const oldest = await this.raids
      .find({ unlistedAt: { $exists: false } }, { projection: { catalogueUpdatedAt: 1 } })
      .sort({ catalogueUpdatedAt: 1 })
      .limit(1)
      .next();

    return oldest?.catalogueUpdatedAt ?? null;
  }

  /**
   * The highest expansion any listed raid belongs to, or null with none stored.
   * What tells a walk the end of the list from a hole in the middle of it.
   */
  async highestListedExpansion(): Promise<number | null> {
    const newest = await this.raids
      .find({ unlistedAt: { $exists: false } }, { projection: { expansionId: 1 } })
      .sort({ expansionId: -1 })
      .limit(1)
      .next();

    return newest?.expansionId ?? null;
  }

  allRaids(): Promise<RaidCatalogueDocument[]> {
    return this.raids
      .find<RaidCatalogueDocument>({}, WITHOUT_BOARDS)
      .sort({ expansionId: 1, id: 1 })
      .toArray();
  }

  findBySlug(slug: string): Promise<RaidCatalogueDocument | null> {
    return this.raids.findOne<RaidCatalogueDocument>({ slug }, WITHOUT_BOARDS);
  }

  countRaids(): Promise<number> {
    return this.raids.countDocuments();
  }
}
