import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

import { MongoService } from '../database/mongo.service.js';
import { GUILDS_COLLECTION, type GuildDocument } from './entities/guild.entity.js';

const DUPLICATE_KEY = 11000;

/** Storage for guilds: one document per guild. */
@Injectable()
export class GuildRepository implements OnModuleInit {
  private readonly logger = new Logger(GuildRepository.name);

  constructor(private readonly mongo: MongoService) {}

  private get guilds() {
    return this.mongo.collection<GuildDocument>(GUILDS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.guilds.createIndexes([
      // The identity, and what a raid's board points at.
      { key: { id: 1 }, name: 'guild_identity', unique: true },
      { key: { region: 1, 'realm.slug': 1, name: 1 }, name: 'guild_region_realm_name' },
    ]);

    this.logger.log(`Indexes ensured on "${GUILDS_COLLECTION}"`);
  }

  /**
   * Writes guilds by id, field-level: a guild is described again by every board
   * that lists it, and the latest description wins.
   */
  async upsertGuilds(guilds: readonly GuildDocument[]): Promise<number> {
    if (guilds.length === 0) return 0;

    const write = () =>
      this.guilds.bulkWrite(
        guilds.map((guild) => ({
          updateOne: { filter: { id: guild.id }, update: { $set: guild }, upsert: true },
        })),
        { ordered: false },
      );

    let result;
    try {
      result = await write();
    } catch (error) {
      // Boards are read several at once and name the same guilds, so two
      // upserts of a guild neither has seen can both try to insert it. The
      // loser's guild exists by the time it hears of it: the same write again
      // is an update.
      if ((error as { code?: number }).code !== DUPLICATE_KEY) throw error;
      result = await write();
    }

    return result.upsertedCount + result.modifiedCount;
  }

  findById(id: number): Promise<GuildDocument | null> {
    return this.guilds.findOne({ id });
  }

  countGuilds(): Promise<number> {
    return this.guilds.countDocuments();
  }
}
