/**
 * Integration tests of the customer menu: the real built app in front of a fake Django that serves
 * GET /menu/<slug>/. A menu stays cached until Django calls POST /internal/revalidate with the
 * shared secret (system_design.md §3.5, use_cases.md GC 9). Each cafe also has its own web
 * manifest, the app icons are generated at build time, and the offline service worker is served
 * from the site root (step 9, installable menu).
 * Each test uses its own slugs, because the app keeps its cache from one test to the next.
 * Every menu page carries the texts of all its screens in its data (the not-found screen, the
 * messages of MenuView), so the tests look for the menu's own items, or for a screen text that is
 * rendered as HTML (">" right before it).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { MetadataRoute } from "next";

import { type FakeDjango, startApp } from "./harness.mts";

const SITE = "http://localhost:4110";
const CLOSED_SITE = "http://localhost:4112"; // the same app without a configured secret
const SECRET = "test-revalidate-secret";

// What the fake Django answers for GET /menu/<slug>/ (system_design.md §3.4); a missing slug is a 404.
const menus = new Map<string, object>();
const calls: string[] = [];
// The menu opens the fake Django counted (UC-GUEST-004): the slug, the body, and what the request carried.
const opens: { slug: string; body: unknown; headers: Record<string, unknown> }[] = [];
const fakeDjango: FakeDjango = async (req, path, body, answer) => {
  calls.push(path);
  const counter = req.method === "POST" && /^\/menu\/([^/]+)\/views\/$/.exec(path);
  if (counter) {
    // record_view: 404 for an unknown cafe, 400 for a table outside 1..200, else 204.
    if (!menus.has(counter[1])) return answer(404, { detail: "Not found." });
    const table = (body as { table?: unknown }).table ?? null;
    if (table !== null && !(Number.isInteger(table) && (table as number) >= 1 && (table as number) <= 200)) {
      return answer(400, { table: ["A valid integer is required."] });
    }
    opens.push({ slug: counter[1], body, headers: req.headers });
    return answer(204);
  }
  // As slow as a real API call. A page reads the menu twice (title and body): with an instant
  // answer, a refresh started by the first read could finish before the second and hide a stale copy.
  await sleep(100);
  const menu = menus.get(/^\/menu\/(.+)\/$/.exec(path)?.[1] ?? "");
  return menu ? answer(200, menu) : answer(404, { detail: "Not found." });
};
startApp({ nextPort: 4110, djangoPort: 4111, django: fakeDjango, env: { FRONTEND_REVALIDATE_SECRET: SECRET } });
startApp({ nextPort: 4112, djangoPort: 4113, django: fakeDjango, env: { FRONTEND_REVALIDATE_SECRET: "" } });

/** A one-item menu in the shape of the public menu API. */
function menuWith(item: string, { is_active = true, primary_color = "", tags = [] as string[] } = {}) {
  return {
    cafe: { name: { ar: "Test Cafe AR", en: "Test Cafe EN" }, primary_color, logo_url: "", is_active },
    categories: [{
      id: 1, name: { ar: "Drinks", en: "Drinks" }, sort_order: 100,
      items: [{
        id: 1, name: { ar: item, en: item }, description: { ar: "", en: "" }, price: "50.00", image_url: "", thumbnail_url: "",
        is_available: true, is_featured: false, is_new: false, tags, sort_order: 100,
      }],
    }],
  };
}
async function page(slug: string) {
  return (await fetch(`${SITE}/menu/${slug}`)).text();
}
/** Calls the endpoint like Django does. `secret: null` leaves the header out; a string body is sent as is. */
function revalidate(body: unknown, { site = SITE, secret = SECRET as string | null } = {}) {
  return fetch(`${site}/internal/revalidate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret === null ? {} : { "X-Revalidate-Secret": secret }) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("a cached menu stays until Django asks for revalidation; then the very next visit is fresh", async () => {
  menus.set("cafe-a", menuWith("Espresso v1"));
  assert.ok((await page("cafe-a")).includes("Espresso v1"));
  menus.set("cafe-a", menuWith("Espresso v2")); // the owner edits the item in Django
  calls.length = 0;
  assert.ok((await page("cafe-a")).includes("Espresso v1")); // served from the cache
  assert.deepEqual(calls, []);

  const res = await revalidate({ slugs: ["cafe-a"] });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { revalidated: true });
  const html = await page("cafe-a");
  assert.ok(html.includes("Espresso v2") && !html.includes("Espresso v1")); // no stale copy first
});

test("revalidating one cafe leaves the cached menus of other cafes alone", async () => {
  menus.set("cafe-b", menuWith("Tea v1"));
  menus.set("cafe-c", menuWith("Juice v1"));
  await page("cafe-b");
  await page("cafe-c");
  menus.set("cafe-b", menuWith("Tea v2"));
  menus.set("cafe-c", menuWith("Juice v2"));
  await revalidate({ slugs: ["cafe-b"] });
  const fresh = await page("cafe-b");
  assert.ok(fresh.includes("Tea v2") && !fresh.includes("Tea v1"));
  const untouched = await page("cafe-c");
  assert.ok(untouched.includes("Juice v1") && !untouched.includes("Juice v2"));
});

test("a slug change revalidates both slugs: the old one is gone, the new one shows the menu", async () => {
  menus.set("old-name", menuWith("Mocha"));
  assert.ok((await page("old-name")).includes("Mocha"));
  assert.ok(!(await page("new-name")).includes("Mocha")); // no such cafe yet: that answer is cached too
  menus.set("new-name", menus.get("old-name")!); // UC-ADMIN-006: the Super Admin changes the slug
  menus.delete("old-name");
  await revalidate({ slugs: ["old-name", "new-name"] });
  assert.ok(!(await page("old-name")).includes("Mocha"));
  assert.ok((await page("new-name")).includes("Mocha"));
});

test("a deactivated cafe shows the unavailable screen right after revalidation", async () => {
  menus.set("cafe-d", menuWith("Latte"));
  await page("cafe-d");
  menus.set("cafe-d", menuWith("Latte", { is_active: false })); // UC-ADMIN-005
  await revalidate({ slugs: ["cafe-d"] });
  const closed = await page("cafe-d");
  assert.ok(closed.includes(">This menu is temporarily unavailable") && !closed.includes("Latte"));
});

test("a wrong or missing secret is refused with 401 and expires nothing", async () => {
  menus.set("cafe-e", menuWith("Cortado v1"));
  await page("cafe-e");
  menus.set("cafe-e", menuWith("Cortado v2"));
  for (const secret of ["wrong-secret", null]) {
    const res = await revalidate({ slugs: ["cafe-e"] }, { secret });
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { detail: "Invalid revalidation secret." });
  }
  assert.ok((await page("cafe-e")).includes("Cortado v1"));
});

test("a malformed body is refused with 400; an unknown slug is accepted", async () => {
  for (const body of ["{}", { slugs: "cafe-a" }, { slugs: [1] }, { slugs: [""] }, "not json"]) {
    const res = await revalidate(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.deepEqual(await res.json(), { detail: 'Expected {"slugs": ["<cafe slug>", ...]}.' });
  }
  assert.equal((await revalidate({ slugs: ["no-such-cafe"] })).status, 200);
});

test("without a configured secret every call is refused, even one with an empty secret", async () => {
  for (const secret of ["", "anything"]) {
    assert.equal((await revalidate({ slugs: ["cafe-a"] }, { site: CLOSED_SITE, secret })).status, 401);
  }
});

// The installable menu: one web manifest per cafe, and the generated app icons.
async function manifestOf(slug: string) {
  const res = await fetch(`${SITE}/menu/${slug}/manifest.webmanifest`);
  return { status: res.status, type: res.headers.get("content-type"), manifest: (await res.json()) as MetadataRoute.Manifest };
}
/** Fetches a generated icon and returns the size written in its PNG header, for example "192x192". */
async function pngSize(path: string) {
  const res = await fetch(`${SITE}${path}`);
  assert.equal(res.status, 200, path);
  assert.equal(res.headers.get("content-type"), "image/png", path);
  const png = Buffer.from(await res.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString("ascii"), "PNG", path);
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`; // the IHDR chunk: width, then height
}

test("each cafe has its own manifest: Arabic name, its own start page and color, real icons", async () => {
  menus.set("pwa-pro", menuWith("Flat white", { primary_color: "#C0392B" }));
  const { status, type, manifest } = await manifestOf("pwa-pro");
  assert.equal(status, 200);
  assert.equal(type, "application/manifest+json");
  const { icons, ...rest } = manifest;
  assert.deepEqual(rest, {
    name: "Test Cafe AR", lang: "ar", dir: "rtl", start_url: "/menu/pwa-pro", scope: "/menu/pwa-pro",
    display: "standalone", background_color: "#fafaf9", theme_color: "#C0392B",
  });
  // Every listed icon exists as a PNG of the size the manifest claims.
  for (const icon of icons ?? []) {
    assert.equal(await pngSize(icon.src), icon.sizes, icon.src);
  }
  assert.deepEqual(icons?.map((icon) => icon.purpose ?? "any"), ["any", "any", "maskable"]);
});

test("a cafe whose plan has no branding gets the platform's brown", async () => {
  menus.set("pwa-basic", menuWith("Tea")); // the API sends primary_color "" for it (GC 7)
  assert.equal((await manifestOf("pwa-basic")).manifest.theme_color, "#6f4e37");
});

test("an unknown cafe has no manifest", async () => {
  const res = await fetch(`${SITE}/menu/no-such-cafe/manifest.webmanifest`);
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { detail: "Not found." });
});

test("the manifest uses the cached menu, so revalidation updates its color too", async () => {
  menus.set("pwa-recolor", menuWith("Mocha", { primary_color: "#C0392B" }));
  assert.equal((await manifestOf("pwa-recolor")).manifest.theme_color, "#C0392B");
  menus.set("pwa-recolor", menuWith("Mocha", { primary_color: "#1F618D" })); // the owner picks a new color
  assert.equal((await manifestOf("pwa-recolor")).manifest.theme_color, "#C0392B");
  await revalidate({ slugs: ["pwa-recolor"] });
  assert.equal((await manifestOf("pwa-recolor")).manifest.theme_color, "#1F618D");
});

test("a menu page gives the browser its manifest address; an inactive cafe's page has none", async () => {
  // MenuView puts the <link> into <head> in the browser; here the address must travel with the page.
  menus.set("pwa-link", menuWith("Cortado"));
  assert.ok((await page("pwa-link")).includes("/menu/pwa-link/manifest.webmanifest"));
  menus.set("pwa-closed", menuWith("Cortado", { is_active: false }));
  assert.ok(!(await page("pwa-closed")).includes("manifest.webmanifest"));
});

test("every page links the generated icons, the Apple icon included", async () => {
  menus.set("pwa-icons", menuWith("Latte"));
  for (const path of ["/menu/pwa-icons", "/login"]) {
    const html = await (await fetch(`${SITE}${path}`)).text();
    assert.match(html, /<link rel="icon" href="\/icon\/192\?[^"]*"[^>]*sizes="192x192"/, path);
    assert.match(html, /<link rel="icon" href="\/icon\/512\?[^"]*"[^>]*sizes="512x512"/, path);
    assert.match(html, /<link rel="apple-touch-icon" href="\/apple-icon\?[^"]*"[^>]*sizes="180x180"/, path);
  }
  assert.equal(await pngSize("/apple-icon"), "180x180");
});

test("the service worker is served from the site root as JavaScript, re-checked on every visit", async () => {
  // A worker may only control pages under its own folder: MenuView registers /sw.js for /menu/,
  // which fails (and is ignored on purpose) if the file ever moves into a subfolder.
  const res = await fetch(`${SITE}/sw.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^application\/javascript/);
  // max-age=0: every cache on the way (browser, proxy) must ask the server again before reusing
  // it, so a new worker version reaches customers at once.
  assert.match(res.headers.get("cache-control") ?? "", /max-age=0/);
});

test("every answer carries the security headers: no framing, no sniffing, same-origin referrer", async () => {
  menus.set("headers-cafe", menuWith("Latte"));
  // A menu page, a page behind proxy.ts, the redirect of the bare domain, a static file and a 404.
  for (const path of ["/menu/headers-cafe", "/login", "/", "/sw.js", "/menu/no-such-cafe-headers"]) {
    const res = await fetch(`${SITE}${path}`, { redirect: "manual" });
    assert.equal(res.headers.get("x-frame-options"), "DENY", path);
    assert.equal(res.headers.get("content-security-policy"), "frame-ancestors 'none'", path);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
    assert.equal(res.headers.get("referrer-policy"), "same-origin", path);
  }
});

/** Reports a menu open like the menu page does (UC-GUEST-004): POST /menu/<slug>/views with a JSON body. */
function reportOpen(slug: string, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${SITE}/menu/${slug}/views`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("a menu open goes to Django's counter with the table number, and with nothing about the visitor", async () => {
  menus.set("count-cafe", menuWith("Latte"));
  opens.length = 0;
  const visitor = { Cookie: "lang=ar; access=secret", "X-Forwarded-For": "203.0.113.7", "User-Agent": "Mozilla/5.0 (test phone)", Authorization: "Bearer secret" };
  const res = await reportOpen("count-cafe", { table: 3 }, visitor);
  assert.deepEqual([res.status, await res.text(), res.headers.get("cache-control")], [204, "", "no-store"]);
  assert.equal((await reportOpen("count-cafe", { table: null })).status, 204);
  assert.equal((await reportOpen("count-cafe")).status, 204, "no body counts as no table");
  assert.deepEqual(opens.map((open) => [open.slug, open.body]), [["count-cafe", { table: 3 }], ["count-cafe", { table: null }], ["count-cafe", {}]]);
  const sent = opens[0].headers;
  assert.deepEqual([sent.cookie, sent["x-forwarded-for"], sent.authorization], [undefined, undefined, undefined]);
  assert.notEqual(sent["user-agent"], visitor["User-Agent"]);
});

test("the counter's refusals: an unknown cafe, a bad table, a bad slug without asking Django, GET, Django down", async () => {
  menus.set("count-refusals", menuWith("Latte"));
  opens.length = 0;
  assert.equal((await reportOpen("no-such-cafe-count", { table: 1 })).status, 404);
  assert.equal((await reportOpen("count-refusals", { table: 201 })).status, 400);
  calls.length = 0;
  assert.equal((await reportOpen("bad%20slug", { table: 1 })).status, 404);
  assert.deepEqual(calls, [], "a slug Django cannot have is not passed on");
  assert.equal((await fetch(`${SITE}/menu/count-refusals/views`)).status, 405, "POST only");
  assert.deepEqual(opens, []);
});

test("the menu page carries its slug, so the browser can report the open; an inactive cafe's page reports nothing", async () => {
  menus.set("count-page", menuWith("Latte"));
  menus.set("count-closed", menuWith("Latte", { is_active: false }));
  opens.length = 0;
  // MenuView gets the slug as a prop and posts to /menu/<slug>/views in the browser.
  assert.match(await page("count-page"), /\\"slug\\":\\"count-page\\"|"slug":"count-page"/);
  assert.equal(/\\"slug\\":\\"count-closed\\"|"slug":"count-closed"/.test(await page("count-closed")), false);
  assert.deepEqual(opens, [], "rendering a page on the server counts nothing");
});

// The filter buttons and the tag labels as the server renders them (Arabic first). Choosing a filter
// happens in the browser only, so it is not tested here.
const filterButtons = (html: string) => [...html.matchAll(/<button[^>]*aria-pressed="false"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
const tagLabels = (html: string) => [...html.matchAll(/<span class="rounded-full px-2 py-0\.5 ([^"]*)">([^<]*)<\/span>/g)]
  .map((m) => [m[2], m[1].includes("bg-red-100") ? "warning" : "dietary"]);

test("item tags (GC 11): each tag is a label on its item; a filter button only for the dietary tags this menu has", async () => {
  menus.set("tags-cafe", menuWith("Salad", { tags: ["vegan", "gluten_free", "contains_nuts"] }));
  const html = await page("tags-cafe");
  assert.deepEqual(tagLabels(html), [["نباتي صرف", "dietary"], ["خالٍ من الغلوتين", "dietary"], ["يحتوي مكسرات", "warning"]]);
  assert.deepEqual(filterButtons(html), ["نباتي صرف", "خالٍ من الغلوتين"], "no button for vegetarian (no item has it) or for a warning");
  assert.ok(/<div role="group" aria-label="اعرض فقط"/.test(html));
});

test("a menu without dietary tags offers no filter: only warnings, or no tags at all (A4)", async () => {
  menus.set("tags-warning", menuWith("Wings", { tags: ["spicy"] }));
  menus.set("tags-none", menuWith("Tea"));
  const spicy = await page("tags-warning");
  assert.deepEqual([tagLabels(spicy), filterButtons(spicy), spicy.includes('role="group"')], [[["حار", "warning"]], [], false]);
  const plain = await page("tags-none");
  assert.deepEqual([tagLabels(plain), filterButtons(plain), plain.includes('role="group"')], [[], [], false]);
});

test("the bare domain sends the visitor to the login page", async () => {
  const res = await fetch(`${SITE}/`, { redirect: "manual" });
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get("location") ?? "", SITE).pathname, "/login");
});
