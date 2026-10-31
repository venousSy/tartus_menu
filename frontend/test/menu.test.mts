/**
 * Integration tests of the customer menu cache (system_design.md §3.5, use_cases.md GC 9): the
 * real built app in front of a fake Django that serves GET /menu/<slug>/. A menu stays cached
 * until Django calls POST /internal/revalidate with the shared secret.
 * Each test uses its own slugs, because the app keeps its cache from one test to the next.
 * Every menu page carries the texts of all its screens in its data (the not-found screen, the
 * messages of MenuView), so the tests look for the menu's own items, or for a screen text that is
 * rendered as HTML (">" right before it).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { type FakeDjango, startApp } from "./harness.mts";

const SITE = "http://localhost:4110";
const CLOSED_SITE = "http://localhost:4112"; // the same app without a configured secret
const SECRET = "test-revalidate-secret";

// What the fake Django answers for GET /menu/<slug>/ (system_design.md §3.4); a missing slug is a 404.
const menus = new Map<string, object>();
const calls: string[] = [];
const fakeDjango: FakeDjango = async (req, path, body, answer) => {
  calls.push(path);
  // As slow as a real API call. A page reads the menu twice (title and body): with an instant
  // answer, a refresh started by the first read could finish before the second and hide a stale copy.
  await sleep(100);
  const menu = menus.get(/^\/menu\/(.+)\/$/.exec(path)?.[1] ?? "");
  return menu ? answer(200, menu) : answer(404, { detail: "Not found." });
};
startApp({ nextPort: 4110, djangoPort: 4111, django: fakeDjango, env: { FRONTEND_REVALIDATE_SECRET: SECRET } });
startApp({ nextPort: 4112, djangoPort: 4113, django: fakeDjango, env: { FRONTEND_REVALIDATE_SECRET: "" } });

/** A one-item menu in the shape of the public menu API. */
function menuWith(item: string, { is_active = true } = {}) {
  return {
    cafe: { name: { ar: "Test Cafe", en: "Test Cafe" }, primary_color: "", logo_url: "", is_active },
    categories: [{
      id: 1, name: { ar: "Drinks", en: "Drinks" }, sort_order: 100,
      items: [{
        id: 1, name: { ar: item, en: item }, description: { ar: "", en: "" }, price: "50.00", image_url: "",
        is_available: true, is_featured: false, is_new: false, sort_order: 100,
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
