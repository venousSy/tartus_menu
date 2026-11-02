/**
 * Integration tests of the Super Admin's home, cafe list and create screen (UC-ADMIN-009, 002, 001;
 * steps 11.4-11.6): the real built app in front of a fake Django that copies the admin API with
 * DRF's texts. The create form is posted like a browser without JavaScript.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { actionState, adminCookie, formsOf, ownerCookie, shown, submit } from "./forms.mts";
import { type FakeDjango, startApp } from "./harness.mts";

const NEXT_PORT = 4180;
const DJANGO_PORT = 4181;
const SITE = `http://localhost:${NEXT_PORT}`;
const NEW_PAGE = `${SITE}/admin/cafes/new`;

type Cafe = { id: number; name: { ar: string; en: string }; slug: string; plan: string; is_active: boolean; owner_email: string };
type CreateBody = { slug: string; name: { ar: string; en: string }; plan: string; owner: { email: string; password: string } };
const cafe = (n: number): Cafe => ({
  id: n, name: { ar: `مقهى ${n}`, en: `Cafe ${n}` }, slug: n % 10 === 0 ? `tartus-${n}` : `cafe-${n}`,
  plan: n % 2 ? "basic" : "pro", is_active: n % 3 !== 0, owner_email: `owner${n}@example.test`,
});
/** `count` cafes, newest (highest id) first, as Django lists them. */
const cafes = (count: number) => Array.from({ length: count }, (_, i) => cafe(count - i));
const fake = { cafes: cafes(45), status: 0, calls: [] as string[], bodies: [] as CreateBody[] };
beforeEach(() => Object.assign(fake, { cafes: cafes(45), status: 0, calls: [], bodies: [] }));

const fakeDjango: FakeDjango = (req, path, body, answer) => {
  fake.calls.push(`${req.method} ${path}`);
  // A role check (403) or a server error page (500) for every admin call.
  if (fake.status === 500) return answer(500, "<h1>Server Error (500)</h1>", { "Content-Type": "text/html" });
  if (fake.status) return answer(fake.status, { detail: "You do not have permission to perform this action." });
  const url = new URL(path, "http://fake");
  if (url.pathname === "/admin/stats/") {
    const count = (test: (c: Cafe) => boolean) => fake.cafes.filter(test).length;
    return answer(200, {
      total_cafes: fake.cafes.length, active_cafes: count((c) => c.is_active), inactive_cafes: count((c) => !c.is_active),
      basic_plan_count: count((c) => c.plan === "basic"), pro_plan_count: count((c) => c.plan === "pro"),
    });
  }
  if (url.pathname === "/admin/cafes/" && req.method === "GET") {
    // list_cafes: name, slug and owner email contain the search text; PageNumberPagination of 20.
    const search = (url.searchParams.get("search") ?? "").trim().toLowerCase();
    const rows = fake.cafes.filter((c) => !search || [c.name.ar, c.name.en, c.slug, c.owner_email].some((v) => v.toLowerCase().includes(search)));
    const page = Number(url.searchParams.get("page") ?? "1");
    if (!(page >= 1 && page <= Math.max(1, Math.ceil(rows.length / 20)))) return answer(404, { detail: "Invalid page." });
    return answer(200, { count: rows.length, next: null, previous: null, results: rows.slice((page - 1) * 20, page * 20) });
  }
  if (url.pathname === "/admin/cafes/" && req.method === "POST") {
    // AdminCafeCreateSerializer in field order; owner errors nested (UC-ADMIN-001 A2).
    const data = body as unknown as CreateBody;
    fake.bodies.push(data);
    const errors: Record<string, unknown> = {};
    if (!/^[-a-zA-Z0-9_]+$/.test(data.slug)) errors.slug = ['Enter a valid "slug" consisting of letters, numbers, underscores or hyphens.'];
    else if (fake.cafes.some((c) => c.slug === data.slug)) errors.slug = ["A cafe with this slug already exists."];
    if (!data.name.ar.trim()) errors.name = { ar: ["This field may not be blank."] };
    if (!["basic", "pro"].includes(data.plan)) errors.plan = [`Object with name=${data.plan} does not exist.`];
    const owner: Record<string, string[]> = {};
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(data.owner.email)) owner.email = ["Enter a valid email address."];
    else if (fake.cafes.some((c) => c.owner_email === data.owner.email.toLowerCase())) owner.email = ["A user with this email already exists."];
    else if (data.owner.password.length < 8) owner.password = ["This password is too short. It must contain at least 8 characters."];
    if (Object.keys(owner).length) errors.owner = owner;
    if (Object.keys(errors).length) return answer(400, errors);
    const created = { ...cafe(fake.cafes.length + 1), slug: data.slug, name: data.name, plan: data.plan, is_active: false, owner_email: data.owner.email };
    fake.cafes.unshift(created);
    return answer(201, created);
  }
  answer(404, { detail: "Not found." });
};

startApp({ nextPort: NEXT_PORT, djangoPort: DJANGO_PORT, django: fakeDjango });

const cookie = adminCookie();
const get = async (path: string, lang = "ar", as = cookie) => {
  const res = await fetch(`${SITE}${path}`, { headers: { Cookie: `${as}; lang=${lang}` }, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location"), html: await res.text() };
};
const page = async (path: string, lang = "ar") => (await get(path, lang)).html;
/** The cafe ids of the list's rows, in order. */
const rows = (html: string) => [...html.matchAll(/<a[^>]*href="\/admin\/cafes\/(\d+)"/g)].map((m) => Number(m[1]));
/** The list's own page links (search and page in the address). */
const links = (html: string) => [...html.matchAll(/<a[^>]*href="(\/admin\/cafes\?[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
const createForm = async () => formsOf(await page("/admin/cafes/new")).find((f) => f.names.includes("owner_email"))!;
const sendsTo = (html: string, path: string) => html.includes(path) && html.includes("NEXT_REDIRECT");
const GOOD = { slug: "sea-cafe", name_ar: "مقهى البحر", name_en: "Sea Cafe", plan: "pro", owner_email: "new@example.test", owner_password: "a-long-pass-123" };

test("home: the five numbers from Django, the menu with Home open, in Arabic and English", async () => {
  const html = await page("/admin");
  for (const [label, value] of [["كل المقاهي", 45], ["اشتراك مفعّل", 30], ["اشتراك موقوف", 15], ["خطة Basic", 23], ["خطة Pro", 22]] as const) {
    assert.ok(new RegExp(`<dt[^>]*>${label}</dt><dd[^>]*>${value}</dd>`).test(html), label);
  }
  assert.ok(/<a[^>]*aria-current="page"[^>]*href="\/admin"|<a[^>]*href="\/admin"[^>]*aria-current="page"/.test(html), "Home is open");
  assert.equal(/href="\/admin\/cafes"[^>]*aria-current="page"/.test(html), false);
  assert.ok(shown(html, "لوحة المشرف العام") && html.includes('href="/admin/cafes"'));
  assert.deepEqual(fake.calls, ["GET /admin/stats/"]);
  const en = await page("/admin", "en");
  assert.ok(shown(en, "Platform overview") && shown(en, "Active subscriptions") && shown(en, "Manage cafes"));
});

test("roles: Django's 403 ends the session; a Cafe Owner is sent to /dashboard; an outage keeps the frame", async () => {
  fake.status = 403;
  assert.ok(sendsTo((await get("/admin")).html, "/bff/auth/session-ended"), "no longer a Super Admin");
  assert.ok(sendsTo((await get("/admin/cafes")).html, "/bff/auth/session-ended"));
  fake.status = 0;
  const owner = await get("/admin", "ar", ownerCookie());
  assert.deepEqual([owner.status, owner.location], [307, "/dashboard"]);
  fake.status = 500;
  const html = (await get("/admin")).html;
  assert.ok(shown(html, "لوحة المشرف العام") && /<nav aria-label="صفحات لوحة المشرف"/.test(html), "header and menu stay");
  assert.equal(html.includes("NEXT_REDIRECT"), false, "an outage never ends the session");
});

test("the list: pages of 20, newest first, with page links; each row names its cafe", async () => {
  let html = await page("/admin/cafes");
  assert.deepEqual(rows(html), Array.from({ length: 20 }, (_, i) => 45 - i));
  assert.ok(shown(html, "45 مقهى") && shown(html, "الصفحة 1 من 3") && !shown(html, "السابقة"));
  assert.deepEqual(links(html), ["/admin/cafes?page=2"]);
  assert.ok(shown(html, "مقهى 45") && /<bdi dir="ltr" class="font-mono">cafe-45<\/bdi>/.test(html) && shown(html, "owner45@example.test"));
  assert.ok(html.includes('href="/admin/cafes/new"'));
  html = await page("/admin/cafes?page=3");
  assert.deepEqual(rows(html), [5, 4, 3, 2, 1]);
  assert.deepEqual(links(html), ["/admin/cafes?page=2"]);
  assert.ok(shown(html, "الصفحة 3 من 3") && !shown(html, "التالية"));
});

test("a bad page number opens page 1; a page past the end offers page 1 instead of the error screen (D4)", async () => {
  for (const wanted of ["abc", "-2", "1.5", "0"]) assert.equal(rows(await page(`/admin/cafes?page=${wanted}`)).length, 20, wanted);
  assert.ok(fake.calls.every((call) => call === "GET /admin/cafes/?page=1"), "only page 1 reached Django");
  const html = await page("/admin/cafes?page=9&search=cafe");
  assert.ok(html.includes("هذه الصفحة غير موجودة.") && shown(html, "العودة إلى الصفحة الأولى"));
  assert.deepEqual(links(html), ["/admin/cafes?search=cafe"]);
});

test("search: trimmed to Django, kept in the input and the page links; no match; no cafes at all", async () => {
  let html = await page("/admin/cafes?search=%20tartus%20");
  assert.deepEqual(fake.calls, ["GET /admin/cafes/?page=1&search=tartus"]);
  assert.deepEqual(rows(html), [40, 30, 20, 10]);
  assert.ok(shown(html, "4 نتائج لـ«tartus»") && shown(html, "مسح البحث"));
  assert.ok(/<input[^>]*name="search"[^>]*value="tartus"/.test(html));
  const form = /<form[^>]*role="search"[^>]*>/.exec(html)![0];
  assert.ok(form.includes('action="/admin/cafes"') && !/method="post"/i.test(form), "a GET form, so it works without JavaScript");
  html = await page("/admin/cafes?search=cafe&page=2");
  assert.deepEqual(links(html), ["/admin/cafes?search=cafe", "/admin/cafes?page=3&search=cafe"]);
  assert.ok(shown(await page("/admin/cafes?search=nothing"), "لا يوجد مقهى يطابق «nothing»."));
  fake.cafes = [];
  html = await page("/admin/cafes", "en");
  assert.ok(shown(html, "No cafes yet. Add the first one.") && !shown(html, "Clear search"));
});

test("create: the nested body goes to Django as typed, then the browser opens the new cafe (303)", async () => {
  const form = await createForm();
  assert.deepEqual(form.names.filter((n) => !n.startsWith("$")), ["slug", "name_ar", "name_en", "plan", "owner_email", "owner_password"]);
  assert.deepEqual(form.fields.find(([n]) => n === "plan"), ["plan", "basic"], "Basic is chosen at first");
  const html = await page("/admin/cafes/new");
  const password = /<input[^>]*name="owner_password"[^>]*>/.exec(html)![0];
  assert.ok(password.includes('type="password"') && password.includes('autoComplete="new-password"') && password.includes('value=""'), password);
  const res = await submit(NEW_PAGE, cookie, form, GOOD);
  assert.deepEqual([res.status, res.location], [303, "/admin/cafes/46"]);
  assert.deepEqual(fake.bodies, [{
    slug: "sea-cafe", name: { ar: "مقهى البحر", en: "Sea Cafe" }, plan: "pro",
    owner: { email: "new@example.test", password: "a-long-pass-123" },
  }]);
});

test("create refusals: each message at its field (owner ones nested), the typing kept, never the password", async () => {
  let state = actionState((await submit(NEW_PAGE, cookie, await createForm(), { ...GOOD, slug: "bad slug", name_ar: " ", owner_email: "owner44@example.test" })).html);
  assert.deepEqual(state, {
    error: { form: null, fields: { slug: [{ key: "slugFormat" }], "name.ar": [{ key: "required" }], "owner.email": [{ key: "emailTaken" }] } },
    values: { slug: "bad slug", name: { ar: " ", en: "Sea Cafe" }, plan: "pro", email: "owner44@example.test" },
  });
  assert.equal(JSON.stringify(state).includes(GOOD.owner_password), false, "the password never comes back");
  state = actionState((await submit(NEW_PAGE, cookie, await createForm(), { ...GOOD, slug: "cafe-45", plan: "gold", owner_password: "short" })).html);
  assert.deepEqual((state as { error: { fields: object } }).error.fields, {
    slug: [{ key: "slugTaken" }], plan: [{ key: "unknownPlan" }], "owner.password": [{ key: "passwordTooShort", values: { min: 8 } }],
  });
  state = actionState((await submit(NEW_PAGE, cookie, await createForm(), { ...GOOD, owner_email: "nope" })).html);
  assert.deepEqual((state as { error: { fields: object } }).error.fields, { "owner.email": [{ key: "emailFormat" }] });
  assert.equal(fake.cafes.length, 45, "nothing was created");
});

test("create: a 403 ends the session; Django down gives the server error and keeps the typing", async () => {
  const form = await createForm();
  fake.status = 403;
  const res = await submit(NEW_PAGE, cookie, form, GOOD);
  assert.deepEqual([res.status, res.location], [303, "/bff/auth/session-ended"]);
  fake.status = 500;
  const state = actionState((await submit(NEW_PAGE, cookie, form, GOOD)).html) as { error: unknown; values: { slug: string } };
  assert.deepEqual([state.error, state.values.slug], [{ form: { key: "serverError" }, fields: {} }, "sea-cafe"]);
});
