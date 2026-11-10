/**
 * Integration tests of GET /health (system_design.md §3.7): the real built app in front of a fake Django
 * whose GET /health/ can be healthy, report a database outage (503), or be slower than the 2 s timeout.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { type FakeDjango, startApp } from "./harness.mts";

const SITE = "http://localhost:4210";

let django: "up" | "db-down" | "slow" = "up";
let calls = 0;
const fakeDjango: FakeDjango = async (_req, path, _body, answer) => {
  if (path !== "/health/") return answer(404, { detail: "Not found." });
  calls++;
  if (django === "slow") await sleep(3000);
  return django === "db-down"
    ? answer(503, { detail: "Database unavailable." }, { "X-Error-Code": "db_unavailable" })
    : answer(200, { status: "ok" });
};
startApp({ nextPort: 4210, djangoPort: 4211, django: fakeDjango });

async function health() {
  const res = await fetch(`${SITE}/health`);
  return { status: res.status, body: await res.json(), cache: res.headers.get("cache-control") };
}

test("healthy: 200 with status ok, never cached, and Django is asked every time", async () => {
  django = "up";
  calls = 0;
  const first = await health();
  const second = await health();

  assert.deepEqual([first.status, first.body], [200, { status: "ok" }]);
  assert.equal(first.cache, "no-store");
  assert.equal(second.status, 200);
  assert.equal(calls, 2, "no cached answer: each check reaches Django");
});

test("a database outage in Django makes /health answer 503", async () => {
  django = "db-down";
  const { status, body } = await health();

  assert.deepEqual([status, body], [503, { detail: "Service unavailable." }]);
});

test("a Django slower than the timeout counts as down", async () => {
  django = "slow";
  const started = Date.now();
  const { status } = await health();

  assert.equal(status, 503);
  assert.ok(Date.now() - started < 2900, "the check gives up after about 2 s, not after Django's 3 s");
  django = "up";
});
