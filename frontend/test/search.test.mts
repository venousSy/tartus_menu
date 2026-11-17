/**
 * Tests of the search inside the customer menu (use_cases.md UC-GUEST-001 step 9, A6, A7).
 * Two parts:
 * - the rules of the comparison (src/lib/search.ts), called directly: they are plain functions;
 * - the search field as the server renders it: the real built app in front of a fake Django.
 * Typing in the field happens in the browser only, so it is not tested here (the tests run no JavaScript
 * of the page).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { matchesSearch, normalizeSearch, SEARCH_MAX_LENGTH } from "../src/lib/search.ts";
import { type FakeDjango, startApp } from "./harness.mts";

const SITE = "http://localhost:4240";

// What the fake Django answers for GET /menu/<slug>/ (system_design.md §3.4); a missing slug is a 404.
const menus = new Map<string, object>();
const fakeDjango: FakeDjango = (_req, path, _body, answer) => {
  const menu = menus.get(/^\/menu\/(.+)\/$/.exec(path)?.[1] ?? "");
  return menu ? answer(200, menu) : answer(404, { detail: "Not found." });
};
startApp({ nextPort: 4240, djangoPort: 4241, django: fakeDjango });

/** A menu in the shape of the public menu API, with one category of one item, or with no category. */
function menuWith(categories: "one" | "none") {
  const item = {
    id: 1, name: { ar: "شاي", en: "Tea" }, description: { ar: "", en: "" }, price: "50.00", image_url: "", thumbnail_url: "",
    is_available: true, is_featured: false, is_new: false, tags: [], variants: [], sort_order: 100,
  };
  return {
    cafe: { name: { ar: "Test Cafe AR", en: "Test Cafe EN" }, primary_color: "", logo_url: "", is_active: true },
    categories: categories === "one" ? [{ id: 1, name: { ar: "Drinks", en: "Drinks" }, sort_order: 100, items: [item] }] : [],
  };
}
/** The search field's tag in the server HTML, or undefined when the page has none. */
async function searchField(slug: string) {
  const html = await (await fetch(`${SITE}/menu/${slug}`)).text();
  return /<input[^>]*type="search"[^>]*>/.exec(html)?.[0];
}

/** Does a customer who types `typed` find an item with this Arabic name? */
function finds(typed: string, nameAr: string) {
  return matchesSearch({ name: { ar: nameAr, en: "" }, description: { ar: "", en: "" } }, normalizeSearch(typed));
}

test("the search ignores letter case, in both directions", () => {
  assert.equal(normalizeSearch("ESPresso"), "espresso");
  const espresso = { name: { ar: "إسبريسو", en: "Espresso" }, description: { ar: "", en: "" } };
  assert.equal(matchesSearch(espresso, normalizeSearch("ESPRESSO")), true);
  assert.equal(matchesSearch(espresso, normalizeSearch("espr")), true, "a part of the word is enough");
});

test("the search ignores tashkeel and tatweel, in the typed text and in the menu text", () => {
  assert.equal(normalizeSearch("قَهْوَة"), normalizeSearch("قهوة"));
  assert.equal(normalizeSearch("قهـــوة"), normalizeSearch("قهوة"));
  assert.equal(finds("قهوة", "قَهْوَة عربية"), true, "the menu text has the marks");
  assert.equal(finds("كُنَافَة", "كنافة"), true, "the typed text has the marks");
});

test("the letters people type one for the other are the same letter: alef forms, ى and ي, ة and ه", () => {
  assert.equal(finds("اسبريسو", "إسبريسو"), true);
  assert.equal(finds("أيس", "آيس لاتيه"), true);
  assert.equal(finds("مشوي", "مشوى"), true);
  assert.equal(finds("مشوى", "مشوي"), true);
  assert.equal(finds("قهوه", "قهوة عربية"), true);
  assert.equal(finds("كنافة", "كنافه"), true);
});

test("the search reads the name and the description, in Arabic and in English, whatever language is shown", () => {
  const item = { name: { ar: "كابتشينو", en: "Cappuccino" }, description: { ar: "حليب مرغى", en: "Foamed milk" } };
  for (const typed of ["كابت", "cappu", "حليب", "foamed"]) {
    assert.equal(matchesSearch(item, normalizeSearch(typed)), true, typed);
  }
  assert.equal(matchesSearch(item, normalizeSearch("شاي")), false);
  assert.equal(matchesSearch(item, normalizeSearch("tea")), false);
});

test("spaces around and inside the text do not count; spaces only is an empty search (A7)", () => {
  assert.equal(normalizeSearch("  قهوة   عربية  "), normalizeSearch("قهوة عربية"));
  assert.equal(finds("  عربية ", "قهوة عربية"), true);
  assert.equal(normalizeSearch("     "), "");
  assert.equal(normalizeSearch(""), "");
});

test("a menu with a category shows the search field: 50 characters at most, labelled in Arabic first", async () => {
  menus.set("search-cafe", menuWith("one"));
  const field = await searchField("search-cafe");

  assert.ok(field, "the page has a search field");
  assert.equal(SEARCH_MAX_LENGTH, 50);
  assert.ok(field.includes('maxLength="50"') || field.includes('maxlength="50"'));
  assert.ok(field.includes('aria-label="ابحث في القائمة"'));
  assert.ok(field.includes('value=""'), "the field starts empty: the page is the same for every customer");
});

test("a menu without categories has no search field", async () => {
  menus.set("search-empty", menuWith("none"));
  assert.equal(await searchField("search-empty"), undefined);
});
