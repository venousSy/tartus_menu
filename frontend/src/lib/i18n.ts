// Display rules shared by the customer menu and the dashboards (use_cases.md Global Conventions 6 and 10).

export type Lang = "ar" | "en";

/** A bilingual field from the API: {"ar": "...", "en": "..."}. `name` always has `ar`; `description` may be {}. */
export type BilingualText = { ar?: string; en?: string };

/** GC 6: a name has at most this many characters per language (Django checks it too). */
export const NAME_MAX_LENGTH = 100;
/** GC 6: the same for a description. */
export const DESCRIPTION_MAX_LENGTH = 500;

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

/** Every cafe is in Tartus, so dates show Syria's time, not the server's own zone (step 11 decision D7). */
export const TIME_ZONE = "Asia/Damascus";

/** An ISO 8601 time from the API ("2026-11-02T08:30:00Z") as a date and time: Arabic or English words, Western digits (GC 10). */
export function formatDateTime(iso: string, lang: Lang): string {
  return new Intl.DateTimeFormat(`${lang}-u-nu-latn`, { dateStyle: "medium", timeStyle: "short", timeZone: TIME_ZONE })
    .format(new Date(iso));
}

/**
 * A calendar day from the API ("2027-02-10", a subscription's last paid day, GC 5) as a date. A day
 * has no time zone: it is read and shown as UTC, so no zone can move it to its neighbour.
 */
export function formatDate(isoDate: string, lang: Lang): string {
  return new Intl.DateTimeFormat(`${lang}-u-nu-latn`, { dateStyle: "medium", timeZone: "UTC" })
    .format(new Date(`${isoDate}T00:00:00Z`));
}

/** Today's date where the cafes are, as "YYYY-MM-DD" (the "en-CA" locale writes dates that way). */
export function businessToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(new Date());
}

/** The day `months` months after "YYYY-MM-DD"; a day the target month lacks (31 → February) moves into the next month. */
export function addMonths(isoDate: string, months: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + months);
  return date.toISOString().slice(0, 10);
}

/** Dashboards warn when a subscription has this many days or fewer left (GC 5). */
export const EXPIRY_WARNING_DAYS = 7;
