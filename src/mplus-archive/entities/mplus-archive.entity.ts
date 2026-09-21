import type { MplusCharacterDocument } from '../../mplus/entities/mplus-character.entity.js';
import type { MplusRunDocument } from '../../mplus/entities/mplus-run.entity.js';

/**
 * An archived run: the same shape as a live one, kept in its own collection.
 *
 * Separate collections rather than a flag on the live ones, as the PvP archive
 * is. The live collections are rewritten, pruned and merged every pass; the
 * archive is written once and never touched again. Sharing documents would put
 * history within reach of every cleanup written for the live board.
 *
 * `region` is the board it was read from, and `rank` its rank there: the
 * archive reads each region's own board, as the live pass does.
 *
 * Which seasons exist, and each one's archive marker, live in the season
 * catalogue (`mplus_seasons`, `src/mplus-season`), which the live pass reads too.
 */
export type MplusArchiveRunDocument = MplusRunDocument;

/**
 * An archived character: the same shape as a live one, in its own collection.
 *
 * `mythicScore` here is summed over the region's top runs only — at the default
 * 100 pages, its top 2,000. That is a narrower window than the live board's
 * 20,020, so it is comparable only between characters with the same
 * `dungeonsCovered` in the same region, and not with live scores.
 * It never needs the live pass's monotonic merge: the season is over, and the
 * document is written once from one complete read.
 */
export type MplusArchiveCharacterDocument = MplusCharacterDocument;

export const MPLUS_ARCHIVE_RUNS_COLLECTION = 'mplus_archive_runs';
export const MPLUS_ARCHIVE_CHARACTERS_COLLECTION = 'mplus_archive_characters';
