/**
 * Integration tests of the Analytics screen (UC-OWNER-015 summary, UC-OWNER-016 detail; roadmap
 * Phase 3): the real built app in front of a fake Django that copies the analytics API with DRF's
 * texts. The page only reads; the period is in the address (?days=30).
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { ownerCookie, shown } from "./forms.mts";
import { type FakeDjango, startApp } from "./harness.mts";

const NEXT_PORT = 4280;
const DJANGO_PORT = 4281;
const SITE = `http://localhost:${NEXT_PORT}`;

const fake = { active: true, detailed: true, empty: false, calls: [] as string[] };
beforeEach(() => Object.assign(fake, { active: true, detailed: true, empty: false, calls: [] }));

const settings = () => ({
  name: { ar: "Test Cafe AR", en: "Test Cafe EN" }, slug: "test-cafe", primary_color: "", logo_url: "", is_active: fake.active,
  subscription_expires_on: null, days_left: null,
  plan: {
    name: fake.detailed ? "pro" : "basic", max_categories: null, max_items: null, allows_images: true, allows_branding: true,
    allows_detailed_analytics: fake.detailed,
  },
});
/** `days` days ending 2026-11-10, oldest first: the last day has 12 opens, the day before 5, the others none. */
const byDay = (days: number) => Array.from({ length: days }, (_, i) => {
  const date = new Date(Date.UTC(2026, 10, 10 - (days - 1 - i))).toISOString().slice(0, 10);
  return { date, count: fake.empty ? 0 : i === days - 1 ? 12 : i === days - 2 ? 5 : 0 };
});

const fakeDjango: FakeDjango = (req, path, _body, answer) => {
  fake.calls.push(`${req.method} ${path}`);
  if (path === "/dashboard/settings/") return answer(200, settings());
  if (!fake.active) return answer(403, { detail: "Your subscription is inactive. Please contact support." });
  const url = new URL(path, "http://fake");
  const days = Number(url.searchParams.get("days") ?? "7");
  if (![7, 30, 90].includes(days)) return answer(400, { days: [`"${url.searchParams.get("days")}" is not a valid choice.`] });
  const total = fake.empty ? 0 : 17;
  if (url.pathname === "/dashboard/analytics/summary/") return answer(200, { days, total, by_day: byDay(days) });
  if (url.pathname === "/dashboard/analytics/detail/") {
    // detail(): the plan flag first (UC-OWNER-016 A1).
    if (!fake.detailed) {
      return answer(403, { detail: "Detailed analytics require a Pro plan." }, { "Content-Type": "application/json", "X-Error-Code": "analytics_need_pro" });
    }
    return answer(200, {
      days, total,
      by_hour: Array.from({ length: 24 }, (_, hour) => ({ hour, count: fake.empty ? 0 : hour === 9 ? 10 : hour === 21 ? 7 : 0 })),
      by_table: fake.empty ? [] : [{ table_number: 3, count: 9 }, { table_number: 0, count: 6 }, { table_number: 1, count: 2 }],
    });
  }
  answer(404, { detail: "Not found." });
};

startApp({ nextPort: NEXT_PORT, djangoPort: DJANGO_PORT, django: fakeDjango });

const cookie = ownerCookie();
const page = async (query = "", lang = "ar") =>
  (await fetch(`${SITE}/dashboard/analytics${query}`, { headers: { Cookie: `${cookie}; lang=${lang}` } })).text();
/** The numbers of a chart's screen-reader table, by its caption: [row name, value] pairs. */
function tableOf(html: string, caption: string): [string, number][] {
  const table = html.split("<table").find((chunk) => chunk.includes(`<caption>${caption}</caption>`));
  assert.ok(table, `no table "${caption}"`);
  return [...table.split("</table>")[0].matchAll(/<th scope="row">([^<]*)<\/th><td>(\d+)<\/td>/g)].map((m) => [m[1], Number(m[2])]);
}
const analyticsCalls = () => fake.calls.filter((call) => call.includes("/analytics/")).sort();

test("Pro, a week: the total, a bar and a table row per day, the hours and the tables; the menu shows the screen", async () => {
  const html = await page("", "en");
  assert.deepEqual(analyticsCalls(), ["GET /dashboard/analytics/detail/?days=7", "GET /dashboard/analytics/summary/?days=7"]);
  assert.ok(shown(html, "17") && html.includes("menu opens in the last 7 days"));
  const days = tableOf(html, "Menu opens per day");
  assert.deepEqual([days.length, days[0], days[5], days[6]], [7, ["Nov 4, 2026", 0], ["Nov 9, 2026", 5], ["Nov 10, 2026", 12]]);
  const hours = tableOf(html, "Menu opens per hour of the day");
  assert.deepEqual([hours.length, hours[0], hours[9], hours[21]], [24, ["00:00", 0], ["09:00", 10], ["21:00", 7]]);
  // One <rect> per bar: 7 days and 24 hours. Time runs left to right on an Arabic page too.
  assert.equal((html.match(/<rect /g) ?? []).length, 31);
  assert.ok(/<title>Nov 10, 2026: 12<\/title>/.test(html) && (html.match(/<div dir="ltr" aria-hidden="true"/g) ?? []).length === 2);
  // The tables, the most opened first; table 0 is "without a table number".
  const tables = [...html.matchAll(/<span>([^<]*)<\/span><span class="font-semibold">(\d+)<\/span>/g)].map((m) => [m[1], Number(m[2])]);
  assert.deepEqual(tables, [["Table 3", 9], ["Without a table number", 6], ["Table 1", 2]]);
  assert.ok(html.includes('style="width:100%"') && shown(html, "The numbers are approximate. Each time the menu page loads counts as one open, so a reload counts again. Nothing about your customers is stored."));
  assert.ok(/<a[^>]*aria-current="page"[^>]*href="\/dashboard\/analytics"|<a[^>]*href="\/dashboard\/analytics"[^>]*aria-current="page"/.test(html), "the menu entry is open");
});

test("the period comes from the address: 30 and 90 days go to Django; anything else is a week", async () => {
  const html = await page("?days=30");
  assert.deepEqual(analyticsCalls(), ["GET /dashboard/analytics/detail/?days=30", "GET /dashboard/analytics/summary/?days=30"]);
  assert.equal(tableOf(html, "فتح القائمة في كل يوم").length, 30);
  assert.ok(shown(html, "آخر 7 أيام") && shown(html, "آخر 30 يومًا") && shown(html, "آخر 90 يومًا"));
  assert.ok(/<a[^>]*aria-current="page"[^>]*href="\/dashboard\/analytics\?days=30"|href="\/dashboard\/analytics\?days=30"[^>]*aria-current="page"/.test(html));
  // React streams a page this long in pieces that the browser puts together, so the 90 rows are
  // not counted in the raw HTML: the call to Django and the open period link tell the same.
  fake.calls = [];
  const quarter = await page("?days=90");
  assert.deepEqual(analyticsCalls(), ["GET /dashboard/analytics/detail/?days=90", "GET /dashboard/analytics/summary/?days=90"]);
  assert.ok(/href="\/dashboard\/analytics\?days=90"[^>]*aria-current="page"|aria-current="page"[^>]*href="\/dashboard\/analytics\?days=90"/.test(quarter));
  for (const query of ["?days=5", "?days=abc", "?days=30&days=90x", "?days="]) {
    fake.calls = [];
    await page(query);
    assert.ok(analyticsCalls().every((call) => call.endsWith(query === "?days=30&days=90x" ? "?days=30" : "?days=7")), query);
  }
});

test("Basic: the days only, a note about Pro, and Django's detail is never asked (it would answer 403)", async () => {
  fake.detailed = false;
  const html = await page();
  assert.deepEqual(analyticsCalls(), ["GET /dashboard/analytics/summary/?days=7"]);
  assert.equal(tableOf(html, "فتح القائمة في كل يوم").length, 7);
  assert.ok(shown(html, "في خطة Pro ترى أيضًا في أي الساعات ومن أي الطاولات تُفتح قائمتك."));
  assert.equal(html.includes("<caption>فتح القائمة في كل ساعة من اليوم</caption>"), false);
  assert.equal((html.match(/<rect /g) ?? []).length, 7);
});

test("no opens yet: zeros, no bars, and a note instead of the table list", async () => {
  fake.empty = true;
  const html = await page("", "en");
  assert.ok(tableOf(html, "Menu opens per day").every(([, value]) => value === 0));
  assert.ok(shown(html, "No menu opens in this period yet."));
  assert.ok([...html.matchAll(/<rect [^>]*height="([^"]*)"/g)].every((m) => m[1] === "0"), "an empty day draws no bar");
});

test("an inactive cafe sees why, and the page makes no analytics call (GC 5)", async () => {
  fake.active = false;
  const html = await page();
  assert.ok(shown(html, "أرقامك محفوظة. يمكنك رؤيتها من جديد بعد تفعيل الاشتراك."));
  assert.deepEqual(fake.calls, ["GET /dashboard/settings/"]);
});

test("the home page tells which analytics the plan has", async () => {
  const home = async () => (await fetch(`${SITE}/dashboard`, { headers: { Cookie: `${cookie}; lang=en` } })).text();
  assert.ok(shown(await home(), "Menu opens per day, per hour and per table"));
  fake.detailed = false;
  assert.ok(shown(await home(), "Menu opens per day"));
});
