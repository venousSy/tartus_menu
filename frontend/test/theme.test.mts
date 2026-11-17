/**
 * Tests of the light and dark theme of the customer menu (use_cases.md UC-GUEST-001 step 10, A8).
 * Three parts:
 * - the functions of src/lib/theme.ts, called directly with a fake <html>, matchMedia and localStorage;
 * - the inline script that applies a stored choice before the page is drawn, run the same way;
 * - the page and the stylesheet as the server sends them: the real built app in front of a fake Django.
 * Pressing the button in a real browser is not tested here (the tests run no JavaScript of the page).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { readTheme, subscribeTheme, THEME_KEY, THEME_SCRIPT, writeTheme } from "../src/lib/theme.ts";
import { type FakeDjango, startApp } from "./harness.mts";

const SITE = "http://localhost:4250";

// What the fake Django answers for GET /menu/<slug>/ (system_design.md §3.4); a missing slug is a 404.
const menus = new Map<string, object>();
const fakeDjango: FakeDjango = (_req, path, _body, answer) => {
  const menu = menus.get(/^\/menu\/(.+)\/$/.exec(path)?.[1] ?? "");
  return menu ? answer(200, menu) : answer(404, { detail: "Not found." });
};
startApp({ nextPort: 4250, djangoPort: 4251, django: fakeDjango });

/** A one-item menu in the shape of the public menu API. */
function menuWith({ is_active = true } = {}) {
  return {
    cafe: { name: { ar: "Test Cafe AR", en: "Test Cafe EN" }, primary_color: "", logo_url: "", is_active },
    categories: is_active ? [{
      id: 1, name: { ar: "Drinks", en: "Drinks" }, sort_order: 100,
      items: [{
        id: 1, name: { ar: "شاي", en: "Tea" }, description: { ar: "", en: "" }, price: "50.00", image_url: "", thumbnail_url: "",
        is_available: true, is_featured: false, is_new: false, tags: [], variants: [], sort_order: 100,
      }],
    }] : [],
  };
}
async function page(slug: string) {
  return (await fetch(`${SITE}/menu/${slug}`)).text();
}
/** The theme button's tag in the server HTML, or undefined when the page has none. */
const themeButton = (html: string) => /<button[^>]*aria-label="الوضع الداكن"[^>]*>/.exec(html)?.[0];

/**
 * A browser with nothing but what theme.ts uses: <html>'s attributes, matchMedia for the phone's
 * setting, and localStorage (or a localStorage that throws, as when the browser blocks storage).
 */
function fakeBrowser({ phoneDark = false, stored = null as string | null, blocked = false } = {}) {
  const attributes = new Map<string, string>();
  const changeListeners = new Set<() => void>();
  const storage = new Map<string, string>(stored === null ? [] : [[THEME_KEY, stored]]);
  const localStorage = {
    getItem: (key: string) => {
      if (blocked) throw new Error("blocked");
      return storage.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (blocked) throw new Error("blocked");
      storage.set(key, value);
    },
  };
  const documentElement = {
    getAttribute: (name: string) => attributes.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
  };
  const query = {
    get matches() { return phoneDark; },
    addEventListener: (_type: string, listener: () => void) => void changeListeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => void changeListeners.delete(listener),
  };
  Object.assign(globalThis, { document: { documentElement }, window: { matchMedia: () => query }, localStorage });
  return {
    attributes,
    storage,
    /** The phone's setting changes while the page is open. */
    setPhoneDark(dark: boolean) {
      phoneDark = dark;
      changeListeners.forEach((listener) => listener());
    },
    /** Runs the inline <head> script, as the browser does before drawing the page. */
    runScript: () => new Function(THEME_SCRIPT)(),
  };
}

test("with no choice, the theme follows the phone's setting, also when it changes", () => {
  const browser = fakeBrowser({ phoneDark: false });
  let told = 0;
  const unsubscribe = subscribeTheme(() => told++);

  assert.equal(readTheme(), "light");
  browser.setPhoneDark(true);
  assert.equal(readTheme(), "dark");
  assert.equal(told, 1, "the button hears about the change");
  unsubscribe();
  browser.setPhoneDark(false);
  assert.equal(told, 1, "nothing is heard after unsubscribing");
});

test("a press applies the choice on <html> at once, stores it, and wins over the phone's setting", () => {
  const browser = fakeBrowser({ phoneDark: true });
  let told = 0;
  subscribeTheme(() => told++);

  writeTheme("light");
  assert.equal(browser.attributes.get("data-theme"), "light");
  assert.equal(browser.storage.get("menu-theme"), "light");
  assert.equal(readTheme(), "light", "the phone is dark, the guest chose light");
  assert.equal(told, 1);

  writeTheme("dark");
  assert.deepEqual([browser.attributes.get("data-theme"), browser.storage.get("menu-theme"), readTheme()], ["dark", "dark", "dark"]);
});

test("A8: storage blocked, the press still works for this page and nothing throws", () => {
  const browser = fakeBrowser({ phoneDark: true, blocked: true });

  assert.doesNotThrow(() => writeTheme("light"));
  assert.equal(browser.attributes.get("data-theme"), "light");
  assert.equal(readTheme(), "light");
});

test("the inline script applies a stored choice before the page is drawn", () => {
  for (const stored of ["light", "dark"]) {
    const browser = fakeBrowser({ stored });
    browser.runScript();
    assert.equal(browser.attributes.get("data-theme"), stored);
  }
});

test("the inline script leaves the phone's setting alone: no choice, an unknown value, storage blocked (A8)", () => {
  for (const options of [{}, { stored: "purple" }, { stored: "dark", blocked: true }]) {
    const browser = fakeBrowser(options);
    assert.doesNotThrow(() => browser.runScript());
    assert.equal(browser.attributes.has("data-theme"), false, JSON.stringify(options));
  }
});

test("the menu page carries the inline script in <head>, and the same page for everyone: no theme in it", async () => {
  menus.set("theme-cafe", menuWith());
  const html = await page("theme-cafe");
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";

  assert.ok(head.includes(`<script>${THEME_SCRIPT}</script>`), "the script runs from <head>, before <body> is drawn");
  assert.equal(/<html[^>]*data-theme/.test(html), false, "the server never decides the theme");
});

test("the menu offers the theme button, not pressed in the server render", async () => {
  menus.set("theme-button", menuWith());
  const button = themeButton(await page("theme-button"));

  assert.ok(button, "the header has the button");
  assert.ok(button.includes('aria-pressed="false"'));
  assert.ok(button.includes('type="button"'));
});

test("the 'temporarily unavailable' screen (UC-GUEST-002) and the 'not found' screen (A1) have no theme button", async () => {
  menus.set("theme-closed", menuWith({ is_active: false }));
  assert.equal(themeButton(await page("theme-closed")), undefined);
  assert.equal(themeButton(await page("theme-no-such-cafe")), undefined);
});

test("the stylesheet turns dark on for a chosen dark theme, and for the phone's dark setting only when nothing is chosen", async () => {
  menus.set("theme-css", menuWith());
  const html = await page("theme-css");
  const hrefs = [...html.matchAll(/<link rel="stylesheet" href="([^"]+\.css)"/g)].map((match) => match[1]);
  const css = (await Promise.all(hrefs.map(async (href) => (await fetch(`${SITE}${href}`)).text()))).join("\n");

  assert.ok(hrefs.length > 0, "the page links its stylesheet");
  assert.match(css, /\[data-theme=["']?dark["']?\]/);
  assert.match(css, /prefers-color-scheme:\s*dark[\s\S]*:not\(\[data-theme\]\)/);
});
