import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { searchNameOf } from '@denipetrov/spirit-link/search';

import {
  CHARACTERS_COLLECTION,
  GUILDS_COLLECTION,
  HIDDEN_ENTRIES_COLLECTION,
  MPLUS_CHARACTERS_COLLECTION,
} from '../database/collections.js';
import { MongoService } from '../database/mongo.service.js';
import type { CharacterDocument } from '../leaderboard/entities/character.entity.js';
import {
  mplusCharacterKey,
  mplusNameKey,
  type MplusCharacterDocument,
} from '../mplus/entities/mplus-character.entity.js';
import type { GuildDocument } from '../raid/entities/guild.entity.js';
import type { Region } from '../blizzard/blizzard.constants.js';
import type { RaiderIoRegion } from '../raiderio/raiderio.constants.js';
import type { HiddenEntryDocument } from './hidden.entity.js';

/** The collections that carry `hidden`. */
const MARKED_COLLECTIONS = [
  CHARACTERS_COLLECTION,
  MPLUS_CHARACTERS_COLLECTION,
  GUILDS_COLLECTION,
] as const;

/** How many stored documents a change of a player's visibility reached. */
export interface CharacterVisibilityResult {
  characters: number;
  mplusCharacters: number;
}

/**
 * The hidden players and guilds, held in memory and kept in `hidden_entries`.
 *
 * In memory because every write of a character or a guild asks it — hundreds of
 * thousands per sweep — and the list is small and changes only through this
 * service, in this process (the service runs as exactly one instance). It is
 * loaded in `onModuleInit`, which Nest finishes before any scheduler starts in
 * `onApplicationBootstrap`, so no write runs ahead of it.
 *
 * Every write sets `hidden` from here rather than leaving it alone, so a
 * document a write creates — a new season's, or one a character re-earns
 * after dropping off a ladder — is hidden from its first write.
 */
@Injectable()
export class HiddenRegistry implements OnModuleInit {
  private readonly logger = new Logger(HiddenRegistry.name);
  private readonly characters = new Set<string>();
  private readonly guilds = new Set<number>();

  constructor(private readonly mongo: MongoService) {}

  private get entries() {
    return this.mongo.collection<HiddenEntryDocument>(HIDDEN_ENTRIES_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    for (const entry of await this.entries.find({}).toArray()) {
      if (entry.kind === 'character') this.characters.add(entry.key);
      else this.guilds.add(Number(entry.key));
    }

    // Documents written before the field existed are visible: the default,
    // written once. Answered from the `hidden` index, so on every later boot
    // it reads an empty range.
    let defaulted = 0;
    for (const name of MARKED_COLLECTIONS) {
      const result = await this.mongo
        .collection(name)
        .updateMany({ hidden: { $exists: false } }, { $set: { hidden: false } });
      defaulted += result.modifiedCount;
    }

    this.logger.log(
      `${this.characters.size} hidden players, ${this.guilds.size} hidden guilds` +
        (defaulted > 0 ? `; ${defaulted} documents defaulted to visible` : ''),
    );
  }

  /** Whether the player with this name on this realm is hidden. */
  isCharacterHidden(region: string, realmSlug: string, name: string): boolean {
    return this.characters.has(mplusCharacterKey(region, realmSlug, name));
  }

  isGuildHidden(id: number): boolean {
    return this.guilds.has(id);
  }

  /**
   * Hides or shows a player in both games, every season, from now on: the
   * list first, so that writes from here on carry it, then the documents that
   * already exist.
   *
   * A write already under way when this runs may land the old value on the
   * documents it was writing; the next write of each corrects it.
   */
  async setCharacterHidden(
    region: RaiderIoRegion,
    realmSlug: string,
    name: string,
    hidden: boolean,
  ): Promise<CharacterVisibilityResult> {
    const key = mplusCharacterKey(region, realmSlug, name);
    await this.record('character', key, hidden);
    if (hidden) this.characters.add(key);
    else this.characters.delete(key);

    // `characters` has no exact-name field to match on, so the folded name
    // narrows it through its index and the key decides: folding drops
    // accents, and `Bìbà` is a different player from `Biba`.
    const candidates = await this.mongo
      .collection<CharacterDocument>(CHARACTERS_COLLECTION)
      .find(
        // `cn` has no PvP documents (see `REGIONS`): it matches none here.
        { region: region as Region, searchName: searchNameOf(name) },
        { projection: { _id: 1, region: 1, realmSlug: 1, characterName: 1 } },
      )
      .toArray();
    const ids = candidates
      .filter((doc) => mplusCharacterKey(doc.region, doc.realmSlug, doc.characterName) === key)
      .map((doc) => doc._id);
    const characters =
      ids.length === 0
        ? 0
        : (
            await this.mongo
              .collection<CharacterDocument>(CHARACTERS_COLLECTION)
              .updateMany({ _id: { $in: ids } }, { $set: { hidden } })
          ).matchedCount;

    const mplus = await this.mongo
      .collection<MplusCharacterDocument>(MPLUS_CHARACTERS_COLLECTION)
      .updateMany(
        { nameKey: mplusNameKey(name), realmSlug: realmSlug.toLowerCase(), region },
        { $set: { hidden } },
      );

    this.logger.log(
      `Player ${key} ${hidden ? 'hidden' : 'shown'}: ${characters} PvP and ${mplus.matchedCount} Mythic+ documents`,
    );

    return { characters, mplusCharacters: mplus.matchedCount };
  }

  /** Hides or shows a guild, from now on: the list first, then its document. */
  async setGuildHidden(id: number, hidden: boolean): Promise<{ guilds: number }> {
    await this.record('guild', String(id), hidden);
    if (hidden) this.guilds.add(id);
    else this.guilds.delete(id);

    const result = await this.mongo
      .collection<GuildDocument>(GUILDS_COLLECTION)
      .updateOne({ id }, { $set: { hidden } });

    this.logger.log(`Guild ${id} ${hidden ? 'hidden' : 'shown'}: ${result.matchedCount} documents`);

    return { guilds: result.matchedCount };
  }

  private async record(kind: HiddenEntryDocument['kind'], key: string, hidden: boolean) {
    if (hidden) {
      await this.entries.updateOne(
        { kind, key },
        { $setOnInsert: { kind, key, hiddenAt: new Date() } },
        { upsert: true },
      );
    } else {
      await this.entries.deleteOne({ kind, key });
    }
  }
}
