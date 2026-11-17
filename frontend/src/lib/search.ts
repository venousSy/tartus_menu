// Search inside the customer menu (use_cases.md UC-GUEST-001 step 9). It runs in the browser on the
// menu the page already holds: nothing is sent to the server.

import type { BilingualText } from "@/lib/i18n";

/** UC-GUEST-001 step 9: the search field takes at most this many characters. */
export const SEARCH_MAX_LENGTH = 50;

// Arabic marks that change how a word looks, not which word it is: the diacritics (tashkeel,
// U+064B to U+065F), the small alef above a letter (U+0670) and the tatweel that stretches a word (U+0640).
const MARKS = /[ً-ٰٟـ]/g;
// Letters that people type one for the other. Each group becomes its plain form.
const ALEF_FORMS = /[أإآٱ]/g; // أ إ آ ٱ -> ا
const ALEF_MAKSURA = /ى/g; // ى -> ي
const TEH_MARBUTA = /ة/g; // ة -> ه

/**
 * The form of a text that the search compares: no letter case, no Arabic marks, one form for
 * the letters above, single spaces, no space at either end. "" for a text of spaces only (A7).
 * Both the typed text and the menu texts go through it, so "قهوه" finds "قَهْوَة".
 */
export function normalizeSearch(text: string): string {
  return text
    .toLowerCase()
    .replace(MARKS, "")
    .replace(ALEF_FORMS, "ا")
    .replace(ALEF_MAKSURA, "ي")
    .replace(TEH_MARBUTA, "ه")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the name or the description contains `needle` in Arabic or in English, whatever
 * language is displayed. `needle` must already be normalized and not empty.
 */
export function matchesSearch(item: { name: BilingualText; description: BilingualText }, needle: string): boolean {
  return [item.name.ar, item.name.en, item.description.ar, item.description.en]
    .some((text) => text !== undefined && normalizeSearch(text).includes(needle));
}
