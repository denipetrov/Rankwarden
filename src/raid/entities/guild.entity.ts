/**
 * One guild, as Raider.io's raid rankings describe it.
 *
 * One document per guild, keyed by Raider.io's guild `id`, and written from
 * every board the guild appears on — so it is described once however many
 * raids and regions rank it, and a raid's board carries only the id.
 *
 * A guild is never removed: one that drops off every board is still what an
 * older raid's board points at.
 */
export interface GuildDocument {
  id: number;
  name: string;
  /** `alliance` or `horde`, as served. */
  faction: string | null;
  /** Always a url upstream: a guild with no logo of its own carries a default. */
  logo: string | null;
  /**
   * The guild's own region. Not the board's: the `world` board lists guilds of
   * every region, `cn` included even where no `cn` board is read.
   */
  region: string | null;
  /** Guild names are unique only within a realm. */
  realm: { slug: string; name: string | null } | null;
  /** When a board last listed the guild. */
  updatedAt: Date;
}

export const GUILDS_COLLECTION = 'guilds';
