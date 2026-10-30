// Display rules shared by the customer menu and the dashboards (use_cases.md Global Conventions 6 and 10).

export type Lang = "ar" | "en";

/** A bilingual field from the API: {"ar": "...", "en": "..."}. `name` always has `ar`; `description` may be {}. */
export type BilingualText = { ar?: string; en?: string };

/** The cookie that keeps a dashboard user's language. Customer pages use localStorage instead. */
export const LANG_COOKIE = "lang";

/** Any outside value (a cookie, a form field) becomes a supported language; Arabic is the default. */
export function toLang(value: unknown): Lang {
  return value === "en" ? "en" : "ar";
}

export function dirOf(lang: Lang): "rtl" | "ltr" {
  return lang === "ar" ? "rtl" : "ltr";
}

/** The text in the chosen language. A missing or empty English value falls back to Arabic (GC 6). */
export function pickText(text: BilingualText, lang: Lang): string {
  return (lang === "en" && text.en) || text.ar || "";
}

const CURRENCY_LABEL: Record<Lang, string> = { ar: "ل.س", en: "SYP" };

/**
 * The API sends prices as strings with two decimals ("50.00", "12.50"). GC 10: Western digits in
 * both languages, a trailing ".00" hidden, then the currency label. Working on the string keeps the
 * API's digits as they are: no floating point rounding, no locale-specific digits.
 */
export function formatPrice(price: string, lang: Lang): string {
  const amount = price.endsWith(".00") ? price.slice(0, -3) : price;
  return `${amount} ${CURRENCY_LABEL[lang]}`;
}
