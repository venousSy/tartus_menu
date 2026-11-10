/**
 * Integration tests of error tracking on the Next.js server (src/instrumentation.ts, system_design.md §5):
 * the real built app, with SENTRY_DSN pointing at the fake Django server, which then also plays Sentry's
 * ingest endpoint (/api/<project>/envelope/). A route handler error is the trigger: the fake Django answers
 * the QR lookup with a body that is not JSON, so /t/<token> throws.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { type FakeDjango, startApp } from "./harness.mts";

const TOKEN = "44444444-4444-4444-8444-444444444444";
const SECRETS = ["Bearer secret-token-value", "secret-cookie-value", "203.0.113.7"];

function fakeWithTracker(envelopes: string[]): FakeDjango {
  return (_req, path, _body, answer, raw) => {
    if (/^\/api\/\d+\/envelope\/(\?|$)/.test(path)) { // the SDK adds ?sentry_version=...&sentry_key=...
      envelopes.push(raw.toString("utf8"));
      return answer(200, {});
    }
    return answer(200, "this is not JSON", { "Content-Type": "text/plain" }); // makes /t/<token> throw
  };
}

const tracked: string[] = [];
const untracked: string[] = [];
startApp({
  nextPort: 4230, djangoPort: 4231, django: fakeWithTracker(tracked),
  env: { SENTRY_DSN: "http://publickey@127.0.0.1:4231/1", SENTRY_RELEASE: "test-release" },
});
startApp({ nextPort: 4232, djangoPort: 4233, django: fakeWithTracker(untracked), env: { SENTRY_DSN: "" } });

async function failingRequest(site: string) {
  const res = await fetch(`${site}/t/${TOKEN}`, {
    redirect: "manual",
    headers: { Authorization: SECRETS[0], Cookie: `access=${SECRETS[1]}`, "X-Forwarded-For": SECRETS[2] },
  });
  await res.arrayBuffer();
  return res.status;
}

test("with a DSN, a server error reaches the tracker, without credentials or the visitor's address", async () => {
  assert.equal(await failingRequest("http://localhost:4230"), 500);

  for (let i = 0; i < 50 && tracked.length === 0; i++) await sleep(200);
  const sent = tracked.join("\n");
  assert.ok(sent.includes('"type":"event"'), "an error event was sent");
  assert.ok(sent.includes("SyntaxError"), "it names the error");
  assert.ok(sent.includes("test-release"), "it names the release");
  for (const secret of SECRETS) assert.ok(!sent.includes(secret), `"${secret}" must not be sent`);
});

test("without a DSN nothing is sent", async () => {
  assert.equal(await failingRequest("http://localhost:4232"), 500);
  await sleep(2000);
  assert.deepEqual(untracked, []);
});
