import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  isRegion,
  RATING_FAMILIES,
  SPEC_SPLIT_FAMILIES,
  type RatingFamily,
  type Region,
} from '../blizzard/blizzard.constants.js';
import type { Env } from '../config/env.schema.js';
import { MongoService } from '../database/mongo.service.js';
import { CHARACTERS_COLLECTION } from '../leaderboard/entities/character.entity.js';
import { SeasonService } from '../season/season.service.js';
import {
  SPEC_REPRESENTATION_COLLECTION,
  startOfUtcDay,
  toSlug,
  type SpecRepresentationDocument,
  type SpecShare,
} from './entities/spec-representation.entity.js';

interface HeroTalentRef {
  id: number;
  name: string;
}

/** One (class, spec, hero tree) combination and how many players held it. */
interface Tally {
  class: string;
  spec: string;
  heroTalent: HeroTalentRef | null;
  count: number;
}

interface Counted {
  total: number;
  classified: number;
  tallies: Tally[];
}

export interface SnapshotSummary {
  date: Date;
  written: number;
  skipped: number;
  /** Snapshots dropped because they predate the current season. */
  purged: number;
  durationMs: number;
}

/**
 * Builds the daily "flavour of the month" snapshot: what share of the players
 * above a rating cutoff is each specialisation, and within a specialisation,
 * each hero talent tree.
 *
 * Everything is counted from `characters`, because that is the only place the
 * two dimensions meet — the bracket name gives class and spec, the enriched
 * profile gives the hero tree. Counting from one source also means the spec
 * totals and the hero talent totals can never disagree.
 */
@Injectable()
export class SpecRepresentationService implements OnModuleInit {
  private readonly logger = new Logger(SpecRepresentationService.name);
  private readonly regions: Region[];
  private readonly minRatings: number[];

  constructor(
    config: ConfigService<Env, true>,
    private readonly mongo: MongoService,
    private readonly seasons: SeasonService,
  ) {
    this.regions = config
      .get('BLIZZARD_REGIONS', { infer: true })
      .filter((region): region is Region => isRegion(region));
    this.minRatings = config.get('REPRESENTATION_MIN_RATINGS', { infer: true });
  }

  private get collection() {
    return this.mongo.collection<SpecRepresentationDocument>(SPEC_REPRESENTATION_COLLECTION);
  }

  private get characters() {
    return this.mongo.collection(CHARACTERS_COLLECTION);
  }

  async onModuleInit(): Promise<void> {
    await this.collection.createIndexes([
      {
        key: { date: 1, seasonId: 1, region: 1, family: 1, minRating: 1 },
        name: 'snapshot_identity',
        unique: true,
      },
      // The visualisation's own query: one series over time.
      { key: { seasonId: 1, region: 1, family: 1, minRating: 1, date: 1 }, name: 'series' },
    ]);
    this.logger.log(`Indexes ensured on "${SPEC_REPRESENTATION_COLLECTION}"`);
  }

  /** Whether a snapshot already exists for the given day. */
  async hasSnapshotFor(date: Date): Promise<boolean> {
    return (await this.collection.countDocuments({ date: startOfUtcDay(date) }, { limit: 1 })) > 0;
  }

  /**
   * Computes and stores one day's snapshot for every region, family and cutoff.
   * Re-running for the same day overwrites it rather than duplicating.
   */
  async snapshot(now = new Date()): Promise<SnapshotSummary> {
    const date = startOfUtcDay(now);
    const startedAt = Date.now();
    const computedAt = new Date();
    let written = 0;
    let skipped = 0;
    let purged = 0;

    for (const region of this.regions) {
      const seasonId =
        this.seasons.getCurrentSeason(region) ?? (await this.seasons.refresh(region));

      purged += await this.pruneBeforeSeasonStart(region);

      for (const family of RATING_FAMILIES) {
        for (const minRating of this.minRatings) {
          const counted = await this.count(family, seasonId, region, minRating);

          if (counted.total === 0) {
            skipped += 1;
            continue;
          }

          await this.collection.updateOne(
            { date, seasonId, region, family, minRating },
            {
              $set: {
                total: counted.total,
                classified: counted.classified,
                specs: this.toShares(counted.tallies, counted.classified),
                computedAt,
              },
              $setOnInsert: { date, seasonId, region, family, minRating },
            },
            { upsert: true },
          );
          written += 1;
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    this.logger.log(
      `Representation snapshot for ${date.toISOString().slice(0, 10)}: ` +
        `${written} series written, ${skipped} empty, ${purged} stale purged, ${durationMs}ms`,
    );

    return { date, written, skipped, purged, durationMs };
  }

  /**
   * Drops snapshots taken before the current season began. A new season resets
   * every ladder, so earlier curves describe a population that no longer exists
   * and would only stretch the visualisation's axis.
   */
  private async pruneBeforeSeasonStart(region: Region): Promise<number> {
    const seasonStart = this.seasons.getSeasonStart(region);
    if (!seasonStart) return 0;

    const result = await this.collection.deleteMany({
      region,
      date: { $lt: startOfUtcDay(seasonStart) },
    });

    if (result.deletedCount > 0) {
      this.logger.log(
        `Purged ${result.deletedCount} ${region} snapshots from before ` +
          `${seasonStart.toISOString().slice(0, 10)}`,
      );
    }

    return result.deletedCount;
  }

  /** Folds flat tallies into specs, each carrying its own hero talent breakdown. */
  private toShares(tallies: Tally[], classified: number): SpecShare[] {
    const bySpec = new Map<string, SpecShare>();

    for (const tally of tallies) {
      const key = `${tally.class}/${tally.spec}`;
      const spec = bySpec.get(key) ?? {
        class: tally.class,
        spec: tally.spec,
        count: 0,
        share: 0,
        heroTalentsClassified: 0,
        heroTalents: [],
      };

      spec.count += tally.count;

      if (tally.heroTalent) {
        spec.heroTalentsClassified += tally.count;
        const existing = spec.heroTalents.find((entry) => entry.id === tally.heroTalent?.id);

        if (existing) {
          existing.count += tally.count;
        } else {
          spec.heroTalents.push({
            id: tally.heroTalent.id,
            name: tally.heroTalent.name,
            count: tally.count,
            share: 0,
          });
        }
      }

      bySpec.set(key, spec);
    }

    const ratio = (count: number, of: number) => (of === 0 ? 0 : Number((count / of).toFixed(4)));

    return [...bySpec.values()]
      .map((spec) => ({
        ...spec,
        share: ratio(spec.count, classified),
        heroTalents: spec.heroTalents
          .map((tree) => ({ ...tree, share: ratio(tree.count, spec.heroTalentsClassified) }))
          .sort((a, b) => b.count - a.count),
      }))
      .sort((a, b) => b.count - a.count);
  }

  private count(
    family: RatingFamily,
    seasonId: number,
    region: Region,
    minRating: number,
  ): Promise<Counted> {
    return (SPEC_SPLIT_FAMILIES as readonly string[]).includes(family)
      ? this.countSpecSplit(family, seasonId, region, minRating)
      : this.countCore(family, seasonId, region, minRating);
  }

  /**
   * Shuffle and blitz: class and spec come from the bracket key, so they are
   * always known. The hero tree has to be the one from *that spec's* loadout —
   * `profile.heroTalentTree` belongs to whichever spec the character is
   * currently playing, and using it here credits a Fury warrior's Mountain Thane
   * to the Arms ladder, a pairing the game does not allow.
   */
  private async countSpecSplit(
    family: RatingFamily,
    seasonId: number,
    region: Region,
    minRating: number,
  ): Promise<Counted> {
    const rows = await this.characters
      .aggregate<{ _id: { bracket: string; heroTalent: HeroTalentRef | null }; count: number }>(
        [
          { $match: { seasonId, region } },
          {
            $project: {
              ratings: { $objectToArray: '$ratings' },
              loadouts: { $ifNull: ['$profile.talentLoadouts', []] },
            },
          },
          { $unwind: '$ratings' },
          {
            $match: {
              'ratings.k': { $regex: `^${family}-` },
              'ratings.v': { $gte: minRating },
            },
          },
          {
            // "shuffle-hunter-beastmastery" -> "beastmastery". Class and spec
            // slugs never contain a hyphen, so the third part is the spec.
            $addFields: {
              specSlug: { $arrayElemAt: [{ $split: ['$ratings.k', '-'] }, 2] },
            },
          },
          {
            $addFields: {
              heroTalent: {
                $first: {
                  $map: {
                    input: {
                      $filter: {
                        input: '$loadouts',
                        cond: {
                          $eq: [
                            {
                              $replaceAll: {
                                input: { $toLower: '$$this.spec.name' },
                                find: ' ',
                                replacement: '',
                              },
                            },
                            '$specSlug',
                          ],
                        },
                      },
                    },
                    in: '$$this.heroTalentTree',
                  },
                },
              },
            },
          },
          {
            $group: {
              _id: { bracket: '$ratings.k', heroTalent: '$heroTalent' },
              count: { $sum: 1 },
            },
          },
        ],
        { allowDiskUse: true },
      )
      .toArray();

    const tallies: Tally[] = [];
    let total = 0;

    for (const row of rows) {
      total += row.count;
      // "shuffle-demonhunter-havoc" -> class "demonhunter", spec "havoc".
      const [className, specName] = row._id.bracket.slice(family.length + 1).split('-');
      if (!className || !specName) continue;

      tallies.push({
        class: className,
        spec: specName,
        heroTalent: row._id.heroTalent ?? null,
        count: row.count,
      });
    }

    return { total, classified: total, tallies };
  }

  /**
   * 2v2, 3v3 and rbg: one rating per character, so class, spec and hero tree all
   * come from the enriched profile. Characters without one count toward `total`
   * but not `classified`, which is what says how trustworthy the shares are.
   */
  private async countCore(
    family: RatingFamily,
    seasonId: number,
    region: Region,
    minRating: number,
  ): Promise<Counted> {
    const rows = await this.characters
      .aggregate<{
        _id: { class?: string; spec?: string; heroTalent: HeroTalentRef | null };
        count: number;
      }>([
        { $match: { seasonId, region, [`ratings.${family}`]: { $gte: minRating } } },
        {
          $group: {
            _id: {
              class: '$profile.class.name',
              spec: '$profile.spec.name',
              heroTalent: '$profile.heroTalentTree',
            },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray();

    const tallies: Tally[] = [];
    let total = 0;
    let classified = 0;

    for (const row of rows) {
      total += row.count;
      if (!row._id.class || !row._id.spec) continue;

      classified += row.count;
      tallies.push({
        class: toSlug(row._id.class),
        spec: toSlug(row._id.spec),
        heroTalent: row._id.heroTalent ?? null,
        count: row.count,
      });
    }

    return { total, classified, tallies };
  }
}
