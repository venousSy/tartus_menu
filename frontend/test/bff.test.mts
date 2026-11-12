/**
 * Integration tests of the BFF (system_design.md §3.6): the real built app (`next start`, with
 * src/proxy.ts and the /bff/auth/* routes) in front of a fake Django that copies the auth API of
 * use_cases.md (UC-AUTH-001..004) and GET settings (UC-OWNER-014), which every dashboard page
 * reads. `npm test` builds the app first, then runs this file.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { toApiMessage, toFormError } from "../src/lib/api-errors.ts";
import { type FakeDjango, startApp } from "./harness.mts";

const NEXT_PORT = 4100;
const DJANGO_PORT = 4101;
const SITE = `http://localhost:${NEXT_PORT}`;
const XFF = "203.0.113.7";

// The fake Django keeps just enough state for rotation and the blacklist.
const fake = {
  password: "", calls: [] as string[], forwardedFor: [] as unknown[], down: false,
  access: new Set<string>(), refresh: new Set<string>(), // the tokens that still work
};
// The cafe settings the dashboard layout and home page read (UC-OWNER-014).
const SETTINGS = {
  name: { ar: "Test Cafe AR", en: "Test Cafe EN" }, slug: "test-cafe", primary_color: "", logo_url: "", is_active: true,
  plan: { name: "basic", max_categories: 5, max_items: 20, allows_images: false, allows_branding: false },
};
let serial = 0;
function issuePair(role = "CAFE_OWNER") {
  const part = (data: object) => Buffer.from(JSON.stringify(data)).toString("base64url");
  const token = (lifetime: number) =>
    `${part({ alg: "none" })}.${part({ role, exp: Math.floor(Date.now() / 1000) + lifetime, jti: ++serial })}.x`;
  const pair = { access: token(900), refresh: token(86_400) }; // 15 min, 1 day
  fake.access.add(pair.access);
  fake.refresh.add(pair.refresh);
  return pair;
}

const fakeDjango: FakeDjango = async (req, path, body, answer) => {
  fake.calls.push(path);
  fake.forwardedFor.push(req.headers["x-forwarded-for"]);
  const signedIn = fake.access.has(req.headers.authorization?.replace("Bearer ", "") ?? "");
  const notSignedIn = { detail: "Given token not valid for any token type" };

  if (fake.down) return answer(502, { detail: "Bad Gateway" });
  if (path === "/auth/login/" && body.email === "throttled@test.local") {
    // DRF's throttle (UC-AUTH-001 A4): the wait in Retry-After, the code in X-Error-Code.
    return answer(429, { detail: "Request was throttled. Expected available in 42 seconds." },
      { "Content-Type": "application/json", "Retry-After": "42", "X-Error-Code": "throttled" });
  }
  if (path === "/auth/login/") {
    if (!body.email || !body.password) {
      return answer(400, { email: ["This field is required."], password: ["This field is required."] });
    }
    if (body.password !== fake.password) {
      return answer(401, { detail: "No active account found with the given credentials" });
    }
    return answer(200, { ...issuePair(), role: "CAFE_OWNER" });
  }
  if (path === "/auth/refresh/") {
    await sleep(50); // slow enough for parallel requests to overlap
    return fake.refresh.delete(body.refresh) ? answer(200, issuePair()) : answer(401, { detail: "Token is blacklisted" });
  }
  if (path === "/auth/logout/") {
    if (!signedIn) return answer(401, notSignedIn);
    return fake.refresh.delete(body.refresh) ? answer(205) : answer(400, { detail: "Token is invalid or already blacklisted." });
  }
  if (path === "/auth/change-password/") {
    if (!signedIn) return answer(401, notSignedIn);
    if (body.old_password !== fake.password) return answer(400, { old_password: ["Incorrect password."] });
    fake.password = body.new_password;
    fake.refresh.clear();
    return answer(204);
  }
  if (path === "/auth/password-reset/confirm/") {
    // UC-AUTH-005: the link first (A1, with its code), then the password rules (A2).
    if (body.uid !== "Nw" || body.token !== "good-token") {
      return answer(400, { detail: "This reset link is invalid or has expired." },
        { "Content-Type": "application/json", "X-Error-Code": "reset_link_invalid" });
    }
    if (body.new_password === "12345678") return answer(400, { new_password: ["This password is too common."] });
    fake.password = body.new_password;
    fake.refresh.clear();
    return answer(204);
  }
  if (path === "/auth/password-reset/") {
    // UC-AUTH-006: 204 for every well-formed address; A3, A4 and A5 as Django answers them.
    if (!String(body.email ?? "").includes("@")) return answer(400, { email: ["Enter a valid email address."] });
    if (body.email === "throttled@test.local") {
      return answer(429, { detail: "Request was throttled. Expected available in 1740 seconds." },
        { "Content-Type": "application/json", "Retry-After": "1740", "X-Error-Code": "throttled" });
    }
    if (body.email === "no-mail@test.local") {
      return answer(503, { detail: "Password reset by email is not available. Please contact support." },
        { "Content-Type": "application/json", "X-Error-Code": "email_not_configured" });
    }
    return answer(204);
  }
  if (path === "/dashboard/settings/") {
    return signedIn ? answer(200, SETTINGS) : answer(401, notSignedIn);
  }
  answer(404, { detail: "Not found." });
};

startApp({ nextPort: NEXT_PORT, djangoPort: DJANGO_PORT, django: fakeDjango });
beforeEach(() => {
  Object.assign(fake, { password: "right-password", calls: [], forwardedFor: [], down: false });
  fake.access.clear();
  fake.refresh.clear();
});

function post(path: string, { body = {}, cookie = "", origin = SITE }: { body?: object; cookie?: string; origin?: string } = {}) {
  return fetch(`${SITE}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie, "X-Forwarded-For": XFF },
    body: JSON.stringify(body),
  });
}
/** The cookies a browser keeps after this response: a later Set-Cookie of the same name wins. */
function kept(res: Response): Record<string, string> {
  const jar: Record<string, string> = {};
  for (const [nameValue] of res.headers.getSetCookie().map((cookie) => cookie.split(";"))) {
    jar[nameValue.slice(0, nameValue.indexOf("="))] = nameValue.slice(nameValue.indexOf("=") + 1);
  }
  return jar;
}
async function signIn() {
  const { access, refresh } = kept(await post("/bff/auth/login", { body: { email: "owner@test.local", password: fake.password } }));
  fake.calls = [];
  return { access, refresh, cookie: `access=${access}; refresh=${refresh}` };
}
function assertSignedOut(res: Response, status: number) {
  assert.equal(res.status, status);
  assert.deepEqual(kept(res), { access: "", refresh: "" });
  for (const cookie of res.headers.getSetCookie()) assert.match(cookie, /Max-Age=0/);
}

test("login: a request from another site is refused before Django is called", async () => {
  const res = await post("/bff/auth/login", { body: { email: "owner@test.local", password: fake.password }, origin: "https://evil.example" });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { detail: "Origin check failed." });
  assert.deepEqual(fake.calls, []);
});

test("login: the pair goes into HttpOnly cookies, the browser gets only the role", async () => {
  const res = await post("/bff/auth/login", { body: { email: "owner@test.local", password: fake.password } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { role: "CAFE_OWNER" });
  assert.deepEqual(Object.keys(kept(res)).sort(), ["access", "refresh"]);
  for (const cookie of res.headers.getSetCookie()) {
    for (const flag of ["Path=/", "Max-Age=", "Secure", "HttpOnly", "SameSite=strict"]) assert.ok(cookie.includes(flag), cookie);
  }
  // Max-Age, relative to now, so the browser's clock does not matter: 15 min minus 30 s, and 1 day.
  const maxAge = (name: string) => Number(res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.match(/Max-Age=(\d+)/)?.[1]);
  assert.ok(Math.abs(maxAge("access") - 870) <= 2, `access Max-Age ${maxAge("access")}`);
  assert.ok(Math.abs(maxAge("refresh") - 86_400) <= 2, `refresh Max-Age ${maxAge("refresh")}`);
  assert.deepEqual(fake.forwardedFor, [XFF]); // forwarded unchanged, for the login throttle
});

test("login: Django's 401 and 400 reach the browser unchanged, without cookies", async () => {
  const wrong = await post("/bff/auth/login", { body: { email: "owner@test.local", password: "wrong" } });
  assert.equal(wrong.status, 401);
  assert.deepEqual(await wrong.json(), { detail: "No active account found with the given credentials" });
  assert.deepEqual(kept(wrong), {});
  const missing = await post("/bff/auth/login");
  assert.equal(missing.status, 400);
  assert.deepEqual(Object.keys(await missing.json()).sort(), ["email", "password"]);
});

test("login: a 429 keeps Django's Retry-After and X-Error-Code headers for the form", async () => {
  const res = await post("/bff/auth/login", { body: { email: "throttled@test.local", password: "x" } });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "42");
  assert.equal(res.headers.get("x-error-code"), "throttled");
});

test("api-errors: Django's code decides the message, the text only gives its numbers", () => {
  // A reworded text still gets its translation through the code.
  assert.deepEqual(toApiMessage("Images need the Pro plan.", "images_need_pro"), { key: "imagesNeedPro" });
  assert.deepEqual(toApiMessage("Images need the Pro plan."), { text: "Images need the Pro plan." });
  const limit = "Your Basic plan allows a maximum of 5 categories. Upgrade to Pro for unlimited.";
  assert.deepEqual(toApiMessage(limit, "plan_limit_categories"), { key: "planLimitCategories", values: { plan: "Basic", max: 5 } });
  // A coded message that needs numbers but whose text no longer gives them: Django's own text.
  assert.deepEqual(toApiMessage("Too many categories.", "plan_limit_categories"), { text: "Too many categories." });
  assert.deepEqual(toFormError({ detail: "Gone." }, "not_found"), { form: { key: "notFound" }, fields: {} });
});

test("logout: both cookies are cleared and Django blacklists the refresh token", async () => {
  const session = await signIn();
  assertSignedOut(await post("/bff/auth/logout", { cookie: session.cookie }), 205);
  assert.deepEqual(fake.calls, ["/auth/logout/"]);
  assert.equal(fake.refresh.has(session.refresh), false);
});

test("logout: the browser is signed out even without cookies or while Django fails", async () => {
  assertSignedOut(await post("/bff/auth/logout"), 205);
  assert.deepEqual(fake.calls, []);
  const session = await signIn();
  fake.down = true;
  assertSignedOut(await post("/bff/auth/logout", { cookie: session.cookie }), 205);
});

test("change-password: without a session the BFF answers 401 itself", async () => {
  const res = await post("/bff/auth/change-password", { body: { old_password: "a", new_password: "b" } });
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { detail: "Authentication credentials were not provided." });
  assert.deepEqual(fake.calls, []);
});

test("change-password: a wrong old password is passed through and keeps the session", async () => {
  const session = await signIn();
  const body = { old_password: "wrong", new_password: "new-password-1" };
  const res = await post("/bff/auth/change-password", { body, cookie: session.cookie });
  assert.equal(res.status, 400);
  assert.deepEqual(await res.json(), { old_password: ["Incorrect password."] });
  assert.deepEqual(kept(res), {});
});

test("change-password: success signs the browser out; Django blacklists every refresh token", async () => {
  const session = await signIn();
  const body = { old_password: fake.password, new_password: "new-password-1" };
  assertSignedOut(await post("/bff/auth/change-password", { body, cookie: session.cookie }), 204);
  assert.equal(fake.refresh.size, 0);
});

test("password-reset: no session is needed and none is started; Django gets the link, the password and the IP", async () => {
  const res = await post("/bff/auth/password-reset", { body: { uid: "Nw", token: "good-token", new_password: "new-password-1" } });
  assert.equal(res.status, 204);
  assert.deepEqual(kept(res), {}); // the owner logs in afterwards
  assert.deepEqual([fake.calls, fake.forwardedFor, fake.password], [["/auth/password-reset/confirm/"], [XFF], "new-password-1"]);
});

test("password-reset: Django's refusals reach the form with the error code; another site is refused", async () => {
  const invalid = await post("/bff/auth/password-reset", { body: { uid: "Nw", token: "used", new_password: "new-password-1" } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("x-error-code"), "reset_link_invalid");
  assert.deepEqual(toFormError(await invalid.json(), "reset_link_invalid"), { form: { key: "resetLinkInvalid" }, fields: {} });
  const weak = await post("/bff/auth/password-reset", { body: { uid: "Nw", token: "good-token", new_password: "12345678" } });
  assert.deepEqual([weak.status, await weak.json()], [400, { new_password: ["This password is too common."] }]);
  fake.calls = [];
  const foreign = await post("/bff/auth/password-reset", { body: { uid: "Nw", token: "good-token", new_password: "x" }, origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  assert.deepEqual(fake.calls, []);
  assert.equal(fake.password, "right-password");
});

test("reset page: open to everyone, never indexed, and it tells no other page where the visitor came from", async () => {
  for (const cookie of ["", both(issuePair()), both(issuePair("SYSTEM_ADMIN"))]) {
    const res = await fetch(`${SITE}/reset-password`, { redirect: "manual", headers: { Cookie: cookie } });
    assert.equal(res.status, 200); // proxy.ts does not run here: a signed-in visitor is not sent home
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.match(await res.text(), /<meta name="robots" content="noindex, nofollow"/);
  }
  assert.deepEqual(fake.calls, []);
});

test("forgot-password: no session is needed and none is started; Django gets the address and the IP", async () => {
  const res = await post("/bff/auth/forgot-password", { body: { email: "owner@test.local" } });
  assert.equal(res.status, 204);
  assert.deepEqual(kept(res), {});
  assert.deepEqual([fake.calls, fake.forwardedFor], [["/auth/password-reset/"], [XFF]]);
});

test("forgot-password: Django's refusals reach the form; another site and a broken Django do not pass", async () => {
  const malformed = await post("/bff/auth/forgot-password", { body: { email: "not-an-address" } });
  assert.deepEqual([malformed.status, await malformed.json()], [400, { email: ["Enter a valid email address."] }]);
  const throttled = await post("/bff/auth/forgot-password", { body: { email: "throttled@test.local" } });
  assert.deepEqual([throttled.status, throttled.headers.get("retry-after")], [429, "1740"]);
  // A5: the one 503 that is an answer, not an outage. The form translates it by its code.
  const noMail = await post("/bff/auth/forgot-password", { body: { email: "no-mail@test.local" } });
  assert.equal(noMail.status, 503);
  assert.deepEqual(toFormError(await noMail.json(), noMail.headers.get("x-error-code")), { form: { key: "emailNotConfigured" }, fields: {} });
  fake.calls = [];
  const foreign = await post("/bff/auth/forgot-password", { body: { email: "owner@test.local" }, origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  assert.deepEqual(fake.calls, []);
  fake.down = true; // a 502 without the code is a failure, not passed on as Django's answer
  assert.equal((await post("/bff/auth/forgot-password", { body: { email: "owner@test.local" } })).status, 500);
});

test("forgot page: open to everyone and never indexed; the login page links to it", async () => {
  for (const cookie of ["", both(issuePair())]) {
    const res = await fetch(`${SITE}/forgot-password`, { redirect: "manual", headers: { Cookie: cookie } });
    assert.equal(res.status, 200); // proxy.ts does not run here
    const html = await res.text();
    assert.match(html, /<meta name="robots" content="noindex, nofollow"/);
    assert.match(html, /<input[^>]*name="email"/);
  }
  assert.match(await (await fetch(`${SITE}/login`)).text(), /<a[^>]*href="\/forgot-password"/);
  assert.deepEqual(fake.calls, []);
});

// src/proxy.ts: role routing and the single-flight refresh. Sessions come straight from the fake
// (issuePair); a request with only the refresh cookie is one whose access cookie has expired.
/**
 * A page visit, read to the end. A streamed page calls Django after its headers have been sent;
 * reading the whole body makes sure those calls arrived before the test checks them, and never
 * during the next test.
 */
async function get(path: string, cookie = "") {
  const res = await fetch(`${SITE}${path}`, { redirect: "manual", headers: { Cookie: cookie, "X-Forwarded-For": XFF } });
  await res.text();
  return res;
}
/** The calls to Django's auth API. Dashboard pages also read their settings; the proxy tests skip those. */
const authCalls = () => fake.calls.filter((path) => path.startsWith("/auth/"));
function assertRedirect(res: Response, path: string) {
  assert.equal(res.status, 307);
  assert.equal(new URL(res.headers.get("location")!, SITE).pathname, path); // Next sends a relative "/login"
}
const both = ({ access, refresh }: { access: string; refresh: string }) => `access=${access}; refresh=${refresh}`;

test("proxy: a visitor without a session is sent to /login", async () => {
  assertRedirect(await get("/dashboard"), "/login");
  assertRedirect(await get("/admin/cafes"), "/login");
  assert.equal((await get("/login")).status, 200);
});

test("proxy: each role lands on its own dashboard, without a refresh", async () => {
  const owner = both(issuePair());
  assert.equal((await get("/dashboard", owner)).status, 200);
  assertRedirect(await get("/admin", owner), "/dashboard");
  assertRedirect(await get("/login", owner), "/dashboard");
  const admin = both(issuePair("SYSTEM_ADMIN"));
  assert.equal((await get("/admin", admin)).status, 200);
  assertRedirect(await get("/dashboard", admin), "/admin");
  assertRedirect(await get("/login", admin), "/admin");
  assert.deepEqual(authCalls(), []);
});

test("proxy: an expired access cookie is refreshed; a late request in the grace period gets the same pair", async () => {
  const old = issuePair();
  const res = await get("/dashboard", `refresh=${old.refresh}`);
  assert.equal(res.status, 200);
  const fresh = kept(res);
  assert.ok(fake.access.has(fresh.access) && fake.refresh.has(fresh.refresh));
  assert.equal(fake.refresh.has(old.refresh), false); // rotated: the old token is blacklisted
  assert.ok(fake.forwardedFor.every((value) => value === XFF)); // the refresh and the page's own read
  assert.deepEqual(kept(await get("/dashboard", `refresh=${old.refresh}`)), fresh);
  assert.deepEqual(authCalls(), ["/auth/refresh/"]);
});

test("proxy: parallel requests with one refresh token share a single refresh", async () => {
  const { refresh } = issuePair();
  const responses = await Promise.all([1, 2, 3].map(() => get("/dashboard", `refresh=${refresh}`)));
  assert.deepEqual(authCalls(), ["/auth/refresh/"]);
  assert.match(kept(responses[0]).access, /^eyJ/);
  for (const res of responses) assert.deepEqual(kept(res), kept(responses[0]));
});

test("proxy: a redirect carries the new pair too", async () => {
  const res = await get("/admin", `refresh=${issuePair().refresh}`);
  assertRedirect(res, "/dashboard");
  assert.match(kept(res).refresh, /^eyJ/);
});

test("proxy: a BFF route behind it gets the fresh access token", async () => {
  const body = { old_password: "wrong", new_password: "new-password-1" };
  const res = await post("/bff/auth/change-password", { body, cookie: `refresh=${issuePair().refresh}` });
  assert.deepEqual(await res.json(), { old_password: ["Incorrect password."] }); // Django answered, not the BFF's 401
  assert.match(kept(res).access, /^eyJ/); // the new pair stays in the browser
  assert.deepEqual(fake.calls, ["/auth/refresh/", "/auth/change-password/"]);
});

test("proxy: a logout after a refresh blacklists the new token, and its clearing cookies win", async () => {
  const res = await post("/bff/auth/logout", { cookie: `refresh=${issuePair().refresh}` });
  assert.equal(res.status, 205);
  assert.deepEqual(kept(res), { access: "", refresh: "" }); // the route's Set-Cookie headers come last
  assert.deepEqual(fake.calls, ["/auth/refresh/", "/auth/logout/"]);
  assert.equal(fake.refresh.size, 0);
});

test("proxy: a rejected refresh token ends the session", async () => {
  const { refresh } = issuePair();
  fake.refresh.delete(refresh); // blacklisted, for example by a logout on another device
  const res = await get("/dashboard", `refresh=${refresh}`);
  assertSignedOut(res, 307);
  assertRedirect(res, "/login");
});

test("proxy: a route behind it sees the ended session, not an outage", async () => {
  const { refresh } = issuePair();
  fake.refresh.delete(refresh); // blacklisted, for example by a password change on another device
  const body = { old_password: "a", new_password: "b" };
  const res = await post("/bff/auth/change-password", { body, cookie: `refresh=${refresh}` });
  assertSignedOut(res, 401); // the form then goes to /login, instead of showing "server unreachable"
  assert.deepEqual(fake.calls, ["/auth/refresh/"]);
});

test("change-password: while Django is down the BFF answers 503 and keeps the session", async () => {
  const { refresh } = issuePair();
  fake.down = true;
  const body = { old_password: "a", new_password: "b" };
  const res = await post("/bff/auth/change-password", { body, cookie: `refresh=${refresh}` });
  assert.equal(res.status, 503); // not 401: the form would end a session that is still valid
  assert.deepEqual(kept(res), {});
});

test("proxy: while Django is down nobody is signed out; the refresh token still tells the role", async () => {
  const { refresh } = issuePair();
  fake.down = true;
  const res = await get("/dashboard", `refresh=${refresh}`);
  assert.equal(res.status, 200);
  assert.deepEqual(kept(res), {});
  assertRedirect(await get("/admin", `refresh=${refresh}`), "/dashboard");
});

test("proxy: a POST to a page (a Server Function call) is never redirected", async () => {
  assert.notEqual((await fetch(`${SITE}/dashboard`, { method: "POST", redirect: "manual" })).status, 307);
});

test("proxy: the customer menu never runs the proxy", async () => {
  const res = await get("/menu/some-cafe", `refresh=${issuePair().refresh}`);
  assert.deepEqual(kept(res), {});
  assert.equal(fake.calls.includes("/auth/refresh/"), false);
});
