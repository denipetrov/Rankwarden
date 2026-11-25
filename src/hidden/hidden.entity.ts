/**
 * What a hidden entry names: a player, or a guild.
 *
 * A player is one name on one realm, across both games: it hides that
 * character in `characters` and `mplus_characters` alike, every season. The
 * two collections share no id (see `MplusCharacterDocument`), so the name is
 * the only thing that can name a player in both.
 */
export type HiddenKind = 'character' | 'guild';

/**
 * One hidden player or guild. Present while hidden, removed when unhidden: the
 * list is what every write consults, so a new season's document, or one a
 * character re-earns after dropping off a ladder, comes in hidden too.
 */
export interface HiddenEntryDocument {
  kind: HiddenKind;
  /**
   * For a player, `region/realmSlug/lowercased-name`: the same key
   * `mplusCharacterKey` builds, so a name matches however it is cased or
   * composed. For a guild, its Raider.io id as a string.
   */
  key: string;
  hiddenAt: Date;
}
