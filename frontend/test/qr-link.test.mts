/**
 * Integration tests of the QR short link GET /t/<qr_token> (use_cases.md UC-GUEST-003): the real built
 * app in front of a fake Django that answers GET /qr/<token>/ with { slug, table_number } or 404.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type FakeDjango, startApp } from "./harness.mts";

const SITE = "http://localhost:4220";
const ACTIVE = "11111111-1111-4111-8111-111111111111";
const INACTIVE_TABLE = "22222222-2222-4222-8222-222222222222";
const UNKNOWN = "33333333-3333-4333-8333-333333333333";

let djangoDown = false;
const asked: string[] = [];
const targets: Record<string, object> = {
  [ACTIVE]: { slug: "tartus-coffee", table_number: 3 },
  [INACTIVE_TABLE]: { slug: "tartus-coffee", table_number: null },
};
const fakeDjango: FakeDjango = (_req, path, _body, answer) => {
  asked.push(path);
  if (djangoDown) return answer(500, "<h1>Server Error</h1>", { "Content-Type": "text/html" });
  const target = targets[/^\/qr\/([^/]+)\/$/.exec(path)?.[1] ?? ""];
  return target ? answer(200, target) : answer(404, { detail: "Not found." }, { "X-Error-Code": "not_found" });
};
startApp({ nextPort: 4220, djangoPort: 4221, django: fakeDjango });

/** The first answer of /t/<token>, without following the redirect. */
function open(token: string) {
  return fetch(`${SITE}/t/${token}`, { redirect: "manual" });
}

test("an active table's code redirects (302, not remembered) to its menu with the table number", async () => {
  const res = await open(ACTIVE);

  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/menu/tartus-coffee?table=3");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("the slug is asked every time, so a renamed cafe's printed codes follow it", async () => {
  targets[ACTIVE] = { slug: "sea-view", table_number: 3 };
  const res = await open(ACTIVE);
  targets[ACTIVE] = { slug: "tartus-coffee", table_number: 3 };

  assert.equal(res.headers.get("location"), "/menu/sea-view?table=3");
});

test("an inactive table's code leads to the menu without a table number (A1)", async () => {
  assert.equal((await open(INACTIVE_TABLE)).headers.get("location"), "/menu/tartus-coffee");
});

test("an unknown code goes to the 'not valid' page (A3); a malformed one without asking Django", async () => {
  asked.length = 0;
  const unknown = await open(UNKNOWN);
  const malformed = await open("not-a-token");

  assert.deepEqual([unknown.status, unknown.headers.get("location")], [302, "/qr-invalid"]);
  assert.deepEqual([malformed.status, malformed.headers.get("location")], [302, "/qr-invalid"]);
  assert.deepEqual(asked, [`/qr/${UNKNOWN}/`], "Django is asked only for the well-formed token");
});

test("the 'not valid' page shows the message in Arabic and English and is not indexed", async () => {
  const html = await (await fetch(`${SITE}/qr-invalid`)).text();

  assert.ok(html.includes("رمز QR هذا غير صالح"));
  assert.ok(html.includes("This QR code is not valid."));
  assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
});

test("Django down: 503 with a retry hint, not the 'not valid' page", async () => {
  djangoDown = true;
  const res = await open(ACTIVE);
  djangoDown = false;

  assert.equal(res.status, 503);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal(res.headers.get("location"), null);
});
