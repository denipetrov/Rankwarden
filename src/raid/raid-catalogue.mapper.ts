import type { StaticRaid } from '../raiderio/schemas/raid-static-data.schema.js';
import type { RaidDocument } from './entities/raid.entity.js';

/** Parses a region-keyed timestamp map, dropping anything that is not a date. */
function toDates(values: Record<string, string> | null | undefined): Record<string, Date> {
  const dates: Record<string, Date> = {};

  for (const [region, value] of Object.entries(values ?? {})) {
    const at = Date.parse(value);
    if (Number.isFinite(at)) dates[region] = new Date(at);
  }

  return dates;
}

/** A static-data raid as the catalogue stores it. */
export function toRaidDocument(
  raid: StaticRaid,
  expansionId: number,
  catalogueUpdatedAt: Date,
): Omit<RaidDocument, 'unlistedAt'> {
  return {
    id: raid.id,
    slug: raid.slug,
    name: raid.name,
    shortName: raid.short_name ?? null,
    icon: raid.icon ?? null,
    expansionId,
    starts: toDates(raid.starts),
    ends: toDates(raid.ends),
    encounters: (raid.encounters ?? []).map((encounter) => ({
      id: encounter.id,
      slug: encounter.slug,
      name: encounter.name,
    })),
    catalogueUpdatedAt,
  };
}
