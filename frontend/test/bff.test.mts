/**
 * Integration tests of the BFF (system_design.md §3.6): the real built app (`next start`, with
 * src/proxy.ts and the /bff/auth/* routes) in front of a fake Django that copies the auth API of
 * use_cases.md (UC-AUTH-001..004). `npm test` builds the app first, then runs this file.
 */
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createServer } from "node:http";
import { after, before, beforeEach, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

const NEXT_PORT = 4100;
const DJANGO_PORT = 4101;
const SITE = `http://localhost:${NEXT_PORT}`;
const XFF = "203.0.113.7";

// The fake Django keeps just enough state for rotation and the blacklist.
const fake = {
  password: "", calls: [] as string[], forwardedFor: [] as unknown[], down: false,
  access: new Set<string>(), refresh: new Set<string>(), // the tokens that still work
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

const django = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const path = req.url!.replace("/api/v1", "");
  fake.calls.push(path);
  fake.forwardedFor.push(req.headers["x-forwarded-for"]);
  const answer = (status: number, data?: object) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(data && JSON.stringify(data));
  };
  const signedIn = fake.access.has(req.headers.authorization?.replace("Bearer ", "") ?? "");
  const notSignedIn = { detail: "Given token not valid for any token type" };

  if (fake.down) return answer(502, { detail: "Bad Gateway" });
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
  answer(404, { detail: "Not found." });
});

let next: ChildProcess;
let nextErrors = "";
before(async () => {
  await new Promise<void>((resolve) => django.listen(DJANGO_PORT, "127.0.0.1", resolve));
  next = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(NEXT_PORT)], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, DJANGO_API_URL: `http://127.0.0.1:${DJANGO_PORT}/api/v1` },
    stdio: ["ignore", "ignore", "pipe"],
  });
  next.stderr!.on("data", (chunk) => (nextErrors += chunk));
  for (let attempt = 0; ; attempt++) {
    try {
      await fetch(`${SITE}/login`);
      return;
    } catch {
      if (next.exitCode !== null || attempt === 100) throw new Error(`next start failed:\n${nextErrors}`);
      await sleep(200);
    }
  }
});
after(() => {
  next.kill();
  django.close();
});
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
    for (const flag of ["Path=/", "Expires=", "Secure", "HttpOnly", "SameSite=strict"]) assert.ok(cookie.includes(flag), cookie);
  }
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
