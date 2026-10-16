/**
 * Letters that carry no accent to strip but still have a plain Latin spelling
 * players type instead: `Ærøn` is searched for as `aeron`, `Großmann` as
 * `grossmann`. Applied after lowercasing, so only the lowercase forms appear.
 */
const LATIN_EQUIVALENTS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  ł: 'l',
  þ: 'th',
  ı: 'i',
};
const LATIN_EQUIVALENT = new RegExp(`[${Object.keys(LATIN_EQUIVALENTS).join('')}]`, 'g');

/**
 * A name folded for searching: lowercased, accents removed, ligatures and the
 * few letters above spelled out. `Bìbà`, `BIBA` and `Biba` all fold to `biba`,
 * so one indexed prefix query finds every spelling.
 *
 * Steps, in an order that matters:
 *
 * 1. Lowercase first, so `İ` becomes `i` plus a combining dot that step 3 then
 *    removes, and `ẞ` becomes `ß` for step 4.
 * 2. NFKD splits every accented letter into its base and its marks, and maps
 *    compatibility forms (full-width `Ｂ`, the `ﬁ` ligature) to plain letters.
 * 3. Every combining mark is dropped.
 * 4. The letters NFKD cannot split are spelled out.
 * 5. NFC puts back together what step 2 split and nothing removed — Hangul
 *    syllables, which NFKD breaks into jamo — so Korean names stay readable.
 *
 * Scripts with no accents to fold (Hangul, Chinese, Cyrillic apart from its
 * own diacritics) pass through lowercased, so they are still searchable by
 * prefix exactly as written.
 *
 * **Readers must fold their query with this same function.** A search for a
 * prefix `p` is `{ searchName: { $regex: '^' + escapeRegex(searchNameOf(p)) } }`:
 * anchored and case-sensitive, which MongoDB answers from the index as a range.
 */
export function searchNameOf(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(LATIN_EQUIVALENT, (letter) => LATIN_EQUIVALENTS[letter] ?? letter)
    .normalize('NFC')
    .trim();
}
