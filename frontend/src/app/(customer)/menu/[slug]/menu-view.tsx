"use client";

import Image from "next/image";
import { createTranslator } from "next-intl";
import { useEffect, useSyncExternalStore, type CSSProperties } from "react";
import { readableTextColor } from "@/lib/color";
import { dirOf, formatPrice, pickText, type Lang } from "@/lib/i18n";
import type { PublicMenu, PublicMenuItem } from "@/lib/server/public-menu";
import type en from "@/messages/en.json";

export type MenuMessages = Record<Lang, (typeof en)["Menu"]>;

// The chosen language lives in localStorage, so it survives a reload. React reads it as an
// external store: the server and the first browser render both use Arabic (no hydration
// mismatch), then the saved choice applies.
const LANG_KEY = "menu-lang";
const listeners = new Set<() => void>();
let memoryLang: Lang | null = null; // used when the browser blocks localStorage

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readLang(): Lang {
  if (memoryLang) return memoryLang;
  try {
    return localStorage.getItem(LANG_KEY) === "en" ? "en" : "ar";
  } catch {
    return "ar";
  }
}

function writeLang(lang: Lang) {
  memoryLang = lang;
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {
    // Private mode: the choice lasts until the page is reloaded.
  }
  listeners.forEach((listener) => listener());
}

// The table number is display-only (GC 4) and read in the browser, so one cached page fits all tables.
function readTable(): string | null {
  const table = new URLSearchParams(window.location.search).get("table");
  return table && /^\d{1,4}$/.test(table) ? table : null;
}

const noSubscription = () => () => {};

// The connection state, for the offline note. The server render and the first browser render
// assume "online"; the browser's online and offline events update it.
function subscribeOnline(listener: () => void) {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

const readOffline = () => !navigator.onLine;

export function MenuView({ menu, messages, manifestHref }: {
  menu: PublicMenu;
  messages: MenuMessages;
  manifestHref: string;
}) {
  const lang = useSyncExternalStore(subscribe, readLang, () => "ar" as const);
  const table = useSyncExternalStore(noSubscription, readTable, () => null);
  const offline = useSyncExternalStore(subscribeOnline, readOffline, () => false);
  const t =createTranslator({ locale: lang, messages: { Menu: messages[lang] }, namespace: "Menu" });
  const { cafe, categories } = menu;

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = dirOf(lang);
  }, [lang]);

  // The cafe's web manifest, for "Add to Home Screen". Browsers look for it among the children of
  // <head>, but the metadata of this streamed page lands in <body>, so the link is added here.
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "manifest";
    link.href = manifestHref;
    document.head.append(link);
    return () => link.remove();
  }, [manifestHref]);

  // The offline copy of the menu (public/sw.js). The scope /menu/ keeps the worker away from the
  // dashboards. A browser without service workers simply shows the menu online only.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const firstVisit = !navigator.serviceWorker.controller; // this page loaded without the worker
    navigator.serviceWorker
      .register("/sw.js", { scope: "/menu/" })
      .then(() => navigator.serviceWorker.ready)
      .then((registration) => {
        if (!firstVisit) return; // later visits pass through the worker, which keeps them itself
        const files = performance
          .getEntriesByType("resource")
          .map((entry) => entry.name)
          .filter((name) => name.startsWith(`${location.origin}/_next/static/`));
        registration.active?.postMessage({ type: "keep", page: location.href, files });
      })
      .catch(() => {}); // the offline copy is an extra: if it fails, the menu works as before
  }, []);

  // "" means "no color": the default theme from globals.css stays (GC 7).
  const theme = cafe.primary_color
    ? ({
        "--color-primary": cafe.primary_color,
        "--color-on-primary": readableTextColor(cafe.primary_color),
      } as CSSProperties)
    : undefined;

  return (
    <div style={theme} className="min-h-dvh bg-stone-50 text-stone-900">
      <header className="bg-primary text-on-primary">
        <div className="mx-auto flex max-w-2xl items-center gap-3 px-4 py-4">
          {cafe.logo_url && (
            <Image src={cafe.logo_url} alt="" width={48} height={48} unoptimized
              className="size-12 shrink-0 rounded-full bg-white object-cover" />
          )}
          <div className="min-w-0 flex-1">
            <h1 dir="auto" className="truncate text-xl font-bold">{pickText(cafe.name, lang)}</h1>
            {table && <p className="text-sm opacity-90">{t("table", { number: table })}</p>}
          </div>
          <button type="button" onClick={() => writeLang(lang === "ar" ? "en" : "ar")}
            lang={lang === "ar" ? "en" : "ar"}
            className="min-h-11 shrink-0 rounded-full border border-current px-4 text-sm font-semibold">
            {t("switchLanguage")}
          </button>
        </div>
      </header>

      {offline && (
        <p role="status" className="bg-amber-100 px-4 py-2 text-center text-sm font-semibold text-amber-900">
          {t("offline")}
        </p>
      )}

      {categories.length === 0 ? (
        <p className="px-4 py-16 text-center text-lg text-stone-600">{t("comingSoon")}</p>
      ) : (
        <>
          <nav aria-label={t("categories")} className="sticky top-0 z-10 border-b border-stone-200 bg-white/95 backdrop-blur">
            <ul className="mx-auto flex max-w-2xl gap-2 overflow-x-auto px-4 py-2">
              {categories.map((category) => (
                <li key={category.id}>
                  <a href={`#category-${category.id}`} dir="auto"
                    className="inline-flex min-h-11 items-center whitespace-nowrap rounded-full bg-stone-100 px-4 font-medium">
                    {pickText(category.name, lang)}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
          <main className="mx-auto max-w-2xl px-4 pb-16">
            {categories.map((category) => (
              <section key={category.id} id={`category-${category.id}`} className="scroll-mt-16 pt-6">
                <h2 dir="auto" className="mb-3 border-s-4 border-primary ps-3 text-lg font-bold">
                  {pickText(category.name, lang)}
                </h2>
                <ul className="space-y-3">
                  {category.items.map((item) => (
                    <MenuItemCard key={item.id} item={item} lang={lang} t={t} />
                  ))}
                </ul>
              </section>
            ))}
          </main>
        </>
      )}
    </div>
  );
}

function MenuItemCard({ item, lang, t }: { item: PublicMenuItem; lang: Lang; t: (key: "featured" | "new") => string }) {
  const description = pickText(item.description, lang);
  return (
    <li className="flex gap-3 rounded-xl bg-white p-3 shadow-sm">
      {item.image_url && (
        <Image src={item.image_url} alt="" width={96} height={96} unoptimized
          className="size-24 shrink-0 rounded-lg bg-stone-100 object-cover" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <h3 dir="auto" className="font-semibold">{pickText(item.name, lang)}</h3>
          {/* <bdi> keeps "50 ل.س" in one piece inside right-to-left text. */}
          <bdi className="shrink-0 font-bold">{formatPrice(item.price, lang)}</bdi>
        </div>
        {description && <p dir="auto" className="mt-1 text-sm text-stone-600">{description}</p>}
        {(item.is_featured || item.is_new) && (
          <div className="mt-2 flex gap-2 text-xs font-semibold">
            {item.is_featured && <span className="rounded-full bg-primary px-2 py-0.5 text-on-primary">{t("featured")}</span>}
            {item.is_new && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-emerald-800">{t("new")}</span>}
          </div>
        )}
      </div>
    </li>
  );
}
