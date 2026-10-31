"use client";

import { useLocale } from "next-intl";
import { setLanguage } from "@/i18n/actions";
import { toLang, type Lang } from "@/lib/i18n";

// Each language is offered in its own name, so a reader of either language can find it.
const LANGUAGE_NAMES: Record<Lang, string> = { ar: "العربية", en: "English" };

/** Switches the dashboard language. A plain form: it works even before JavaScript has loaded. */
export function LanguageSwitch() {
  const other: Lang = toLang(useLocale()) === "ar" ? "en" : "ar";
  return (
    <form action={setLanguage}>
      <input type="hidden" name="lang" value={other} />
      <button type="submit" lang={other}
        className="min-h-11 rounded-full border border-stone-300 px-4 text-sm font-semibold">
        {LANGUAGE_NAMES[other]}
      </button>
    </form>
  );
}
