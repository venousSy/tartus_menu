/**
 * Integration tests of the Cafe Owner dashboard's session (step 10, decisions D1-D3): the real built
 * app (`next start`) in front of a fake Django that copies the token refresh (UC-AUTH-002) and GET
 * settings (UC-OWNER-014), which the dashboard layout reads on every page. A dashboard page reads
 * Django with the owner's access token; when Django no longer accepts it, the session ends.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { type FakeDjango, startApp } from "./harness.mts";

const NEXT_PORT = 4120;
const DJANGO_PORT = 4121;
const SITE = `http://localhost:${NEXT_PORT}`;
const XFF = "203.0.113.9";

const SETTINGS = {
  name: { ar: "Test Cafe AR", en: "Test Cafe EN" }, slug: "test-cafe", primary_color: "", logo_url: "", is_active: true,
  plan: { name: "pro", max_categories: null, max_items: null, allows_images: true, allows_branding: true },
};
// What the fake Django remembers: the tokens that still work, and with which token each settings read came.
const fake = {
  access: new Set<string>(), refresh: new Set<string>(), noLongerOwner: new Set<string>(), down: false,
  settingsReads: [] as { token: string; forwardedFor: unknown }[],
};
let serial = 0;
function issuePair() {
  const part = (data: object) => Buffer.from(JSON.stringify(data)).toString("base64url");
  const token = (lifetime: number) =>
    `${part({ alg: "none" })}.${part({ role: "CAFE_OWNER", exp: Math.floor(Date.now() / 1000) + lifetime, jti: ++serial })}.x`;
  const pair = { access: token(900), refresh: token(86_400) };
  fake.access.add(pair.access);
  fake.refresh.add(pair.refresh);
  return pair;
}

const fakeDjango: FakeDjango = (req, path, body, answer) => {
  const token = req.headers.authorization?.replace("Bearer ", "") ?? "";
  if (path === "/auth/refresh/") {
    return fake.refresh.delete(body.refresh) ? answer(200, issuePair()) : answer(401, { detail: "Token is blacklisted" });
  }
  if (path === "/dashboard/settings/") {
    fake.settingsReads.push({ token, forwardedFor: req.headers["x-forwarded-for"] });
    if (fake.down) return answer(502, { detail: "Bad Gateway" });
    if (!fake.access.has(token)) return answer(401, { detail: "Given token not valid for any token type" });
    // The account is no longer a Cafe Owner, but its token still says so (getSettings in owner-api.ts).
    if (fake.noLongerOwner.has(token)) return answer(403, { detail: "You do not have permission to perform this action." });
    return answer(200, SETTINGS);
  }
  answer(404, { detail: "Not found." });
};

startApp({ nextPort: NEXT_PORT, djangoPort: DJANGO_PORT, django: fakeDjango });
beforeEach(() => {
  fake.access.clear();
  fake.refresh.clear();
  fake.noLongerOwner.clear();
  Object.assign(fake, { down: false, settingsReads: [] });
});

/** A page as the browser gets it. The whole body is read: a streamed page calls Django after its headers. */
async function get(path: string, cookie = "", headers: Record<string, string> = {}) {
  const res = await fetch(`${SITE}${path}`, { redirect: "manual", headers: { Cookie: cookie, "X-Forwarded-For": XFF, ...headers } });
  return { res, html: await res.text() };
}
/** Text React rendered as HTML. Every dashboard page also carries all its texts in its page data. */
const shown = (html: string, text: string) => html.includes(`>${text}<`);
/** The cookies a browser keeps after this response: a later Set-Cookie of the same name wins. */
function kept(res: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const [nameValue] of res.headers.getSetCookie().map((cookie) => cookie.split(";"))) {
    jar[nameValue.slice(0, nameValue.indexOf("="))] = nameValue.slice(nameValue.indexOf("=") + 1);
  }
  return jar;
}
const both = ({ access, refresh }: { access: string; refresh: string }) => `access=${access}; refresh=${refresh}`;
// A page cannot redirect with a status once it streams, so Next redirects in the browser instead.
const sendsTo = (html: string, path: string) => html.includes(path) && html.includes("NEXT_REDIRECT");

test("home: the page reads its settings with the owner's access token and shows the cafe", async () => {
  const pair = issuePair();
  const { res, html } = await get("/dashboard", both(pair));
  assert.equal(res.status, 200);
  assert.ok(shown(html, "Test Cafe AR") && shown(html, "تسجيل الخروج"), "cafe name and the logout button");
  assert.deepEqual(fake.settingsReads, [{ token: pair.access, forwardedFor: XFF }]); // one read: layout and page share it
  assert.deepEqual(kept(res), {}, "no cookie changes");
});

test("home: after a refresh the page reads its settings with the new access token (observation 40)", async () => {
  const old = issuePair();
  const { res, html } = await get("/dashboard", `refresh=${old.refresh}`);
  const fresh = kept(res);
  assert.ok(fake.access.has(fresh.access), "the browser got the new pair");
  assert.deepEqual(fake.settingsReads.map((read) => read.token), [fresh.access]); // not the missing old cookie
  assert.ok(shown(html, "Test Cafe AR"), "the page itself, not its error screen");
});

test("a token Django no longer accepts ends the session through /bff/auth/session-ended", async () => {
  const pair = issuePair();
  fake.access.delete(pair.access); // for example the account was deactivated
  const { html } = await get("/dashboard/categories", both(pair));
  assert.ok(sendsTo(html, "/bff/auth/session-ended"));
  assert.equal(shown(html, "Test Cafe AR"), false);
});

test("a role that changed (settings answers 403) ends the session too", async () => {
  const pair = issuePair();
  fake.noLongerOwner.add(pair.access);
  const { html } = await get("/dashboard", both(pair));
  assert.ok(sendsTo(html, "/bff/auth/session-ended"));
});

test("session-ended clears both cookies and opens /login?ended=1; a link from another site clears nothing", async () => {
  const pair = both(issuePair());
  let { res } = await get("/bff/auth/session-ended", pair, { "Sec-Fetch-Site": "same-origin" });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/login?ended=1", "the login form says that the session ended");
  assert.deepEqual(kept(res), { access: "", refresh: "" });
  for (const cookie of res.headers.getSetCookie()) assert.match(cookie, /Max-Age=0/);
  ({ res } = await get("/bff/auth/session-ended", pair, { "Sec-Fetch-Site": "cross-site" }));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/login", "no note for a link from another site");
  assert.deepEqual(res.headers.getSetCookie(), []);
});

test("while Django is down the dashboard stays signed in and keeps its header", async () => {
  fake.down = true;
  const { res, html } = await get("/dashboard", both(issuePair()));
  assert.equal(res.status, 200);
  assert.deepEqual(res.headers.getSetCookie(), [], "nobody is signed out for an outage");
  assert.ok(shown(html, "لوحة تحكم المقهى"), "the header is in the HTML; the error screen is built in the browser");
  assert.equal(sendsTo(html, "/bff/auth/session-ended") || sendsTo(html, "/login"), false);
});
