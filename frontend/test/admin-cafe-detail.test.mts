/**
 * Integration tests of the Super Admin's cafe page (UC-ADMIN-003 details, 008 billing history, 004
 * and 005 activate and deactivate, 006 edit, 007 delete; steps 11.7-11.10): the real built app in
 * front of a fake Django that copies the admin API with DRF's texts. The dialogs' forms are posted
 * like a browser without JavaScript.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { actionState, adminCookie, type Form, formsOf, shown, submit } from "./forms.mts";
import { type FakeDjango, startApp } from "./harness.mts";

const NEXT_PORT = 4200;
const DJANGO_PORT = 4201;
const SITE = `http://localhost:${NEXT_PORT}`;
const PAGE = `${SITE}/admin/cafes/7`;

type Event = { action: string; notes: string; performed_by_email: string | null; created_at: string };
const SEA = () => ({
  id: 7, name: { ar: "مقهى البحر", en: "Sea Cafe" }, slug: "sea-cafe", plan: "pro", is_active: true, owner_email: "owner@example.test",
  subscription_start_at: "2026-11-02T08:30:00Z" as string | null, subscription_end_at: null as string | null,
  subscription_expires_on: "2027-02-10" as string | null, days_left: 92 as number | null,
  logo_url: "https://media.example.test/cafes/7/logo.webp", primary_color: "#C0392B",
});
const EVENTS = (): Event[] => [
  { action: "plan_changed", notes: "Plan changed from Basic to Pro.", performed_by_email: "admin@example.test", created_at: "2026-11-02T09:00:00Z" },
  { action: "activated", notes: "Paid 3 months in cash.\nReceipt 12.", performed_by_email: null, created_at: "2026-11-02T08:30:00Z" },
];
const NEW_CAFE = {
  id: 8, name: { ar: "مقهى جديد", en: "" }, slug: "new-cafe", plan: "basic", is_active: false, owner_email: "new@example.test",
  subscription_start_at: null, subscription_end_at: null, subscription_expires_on: null, days_left: null, logo_url: "", primary_color: "",
};
const RESET_LINK = { url: "https://menu.example.test/reset-password#Nw.d2x4ab-0123456789abcdef", expires_at: "2026-11-03T08:30:00Z" };
const fake = { cafe: SEA() as ReturnType<typeof SEA> | null, events: EVENTS(), categories: 8, status: 0, calls: [] as string[], bodies: [] as unknown[] };
beforeEach(() => Object.assign(fake, { cafe: SEA(), events: EVENTS(), categories: 8, status: 0, calls: [], bodies: [] }));

const fakeDjango: FakeDjango = (req, path, body, answer) => {
  fake.calls.push(`${req.method} ${path}`);
  if (fake.status) return answer(fake.status, { detail: "You do not have permission to perform this action." });
  if (path === "/admin/cafes/8/") return answer(200, NEW_CAFE);
  if (path === "/admin/cafes/8/billing/") return answer(200, []);
  const match = /^\/admin\/cafes\/7\/(billing\/|activate\/|deactivate\/|renew\/|password-reset-link\/)?$/.exec(path);
  const cafe = fake.cafe;
  if (!match || !cafe) return answer(404, { detail: "Not found." });
  if (match[1] === "password-reset-link/") return answer(200, RESET_LINK); // UC-ADMIN-010: nothing changes
  if (req.method !== "GET") fake.bodies.push(body);
  if (match[1] === "billing/") return answer(200, fake.events);
  if (match[1]) {
    // SubscriptionChangeSerializer (notes at most 500), then _set_subscription: A1, the dates, the event.
    // SubscriptionPeriodSerializer (activate/, renew/): the date's format, then the notes.
    const errors: Record<string, string[]> = {};
    if (match[1] !== "deactivate/") {
      if (!body.expires_on) errors.expires_on = ["This field is required."];
      else if (!/^\d{4}-\d{2}-\d{2}$/.test(body.expires_on)) errors.expires_on = ["Date has wrong format. Use one of these formats instead: YYYY-MM-DD."];
    }
    if (String(body.notes ?? "").length > 500) errors.notes = ["Ensure this field has no more than 500 characters."];
    if (Object.keys(errors).length) return answer(400, errors);
    const event = (action: string) =>
      fake.events.unshift({ action, notes: body.notes ?? "", performed_by_email: "admin@example.test", created_at: "2026-11-02T10:00:00Z" });
    if (match[1] === "renew/") {
      // renew_cafe: inactive (A1, with its code), not later than the current day (A2); "today" is 2026-11-10.
      if (!cafe.is_active) return answer(400, { detail: "Cafe is inactive. Activate it instead." }, { "Content-Type": "application/json", "X-Error-Code": "renew_inactive" });
      if (body.expires_on < "2026-11-10") return answer(400, { expires_on: ["The date must be today or later."] });
      if (cafe.subscription_expires_on && body.expires_on <= cafe.subscription_expires_on) {
        return answer(400, { expires_on: ["The date must be later than the current end date."] });
      }
      Object.assign(cafe, { subscription_expires_on: body.expires_on, days_left: 181 });
      event("renewed");
      return answer(200, cafe);
    }
    const active = match[1] === "activate/";
    if (cafe.is_active === active) return answer(400, { detail: `Cafe is already ${active ? "active" : "inactive"}.` });
    Object.assign(cafe, active
      ? { is_active: true, subscription_start_at: "2026-11-02T10:00:00Z", subscription_end_at: null, subscription_expires_on: body.expires_on, days_left: 30 }
      : { is_active: false, subscription_end_at: "2026-11-02T10:00:00Z", days_left: null });
    event(active ? "activated" : "deactivated");
    return answer(200, cafe);
  }
  if (req.method === "PATCH") {
    // AdminCafeUpdateSerializer, then update_cafe: slug taken (A1), the plan's limits (A2), the event.
    const data = body as unknown as { name: { ar: string; en: string }; slug: string; plan: string; primary_color: string };
    const errors: Record<string, unknown> = {};
    if (!data.name.ar.trim()) errors.name = { ar: ["This field may not be blank."] };
    if (!/^[-a-zA-Z0-9_]+$/.test(data.slug)) errors.slug = ['Enter a valid "slug" consisting of letters, numbers, underscores or hyphens.'];
    if (!/^(#[0-9A-Fa-f]{6})?$/.test(data.primary_color)) errors.primary_color = ["Enter a color in #RRGGBB format."];
    if (Object.keys(errors).length) return answer(400, errors);
    if (data.slug === "new-cafe") return answer(400, { slug: ["A cafe with this slug already exists."] });
    if (data.plan === "basic" && cafe.plan !== "basic" && fake.categories > 5) {
      return answer(400, { detail: `Cannot downgrade to Basic: cafe has ${fake.categories} categories (max 5).` });
    }
    if (data.plan !== cafe.plan) {
      const label = (plan: string) => (plan === "pro" ? "Pro" : "Basic");
      fake.events.unshift({ action: "plan_changed", notes: `Plan changed from ${label(cafe.plan)} to ${label(data.plan)}.`, performed_by_email: "admin@example.test", created_at: "2026-11-02T10:00:00Z" });
    }
    Object.assign(cafe, { name: { ar: data.name.ar.trim(), en: data.name.en.trim() }, slug: data.slug, plan: data.plan, primary_color: data.primary_color });
    return answer(200, cafe);
  }
  if (req.method === "DELETE") {
    fake.cafe = null; // delete_cafe: the cafe, its owner and all its rows
    return answer(204);
  }
  answer(200, cafe);
};

startApp({ nextPort: NEXT_PORT, djangoPort: DJANGO_PORT, django: fakeDjango });

const cookie = adminCookie();
const page = async (path = "/admin/cafes/7", lang = "ar") =>
  (await fetch(`${SITE}${path}`, { headers: { Cookie: `${cookie}; lang=${lang}` } })).text();
const formWith = (html: string, field: string) => formsOf(html).find((f) => f.names.includes(field))!;
/** The forms whose only own field is the hidden id: the reset-link form, then the delete form. */
const idOnlyForms = (html: string) => formsOf(html).filter((f) => {
  const own = f.names.filter((n) => !n.startsWith("$"));
  return own.length === 1 && own[0] === "id";
});
const resetLinkForm = (html: string) => idOnlyForms(html)[0];
const deleteForm = (html: string) => idOnlyForms(html)[1];
const value = (form: Form, name: string) => form.fields.find(([n]) => n === name)?.[1];
const writes = () => fake.calls.filter((call) => !call.startsWith("GET"));
const refused = (key: string) => ({ form: { key }, fields: {} });
// A streamed page: the header is sent with 200 before the page finds the cafe missing (observation 45).
const notFoundShown = (html: string) => html.includes("NEXT_HTTP_ERROR_FALLBACK;404") && html.includes("noindex");

test("details: Damascus time with Western digits, color, logo, and the billing log newest first", async () => {
  const html = await page();
  assert.deepEqual(fake.calls.sort(), ["GET /admin/cafes/7/", "GET /admin/cafes/7/billing/"]);
  assert.ok(shown(html, "مقهى البحر") && shown(html, "Sea Cafe") && shown(html, "اشتراك مفعّل") && shown(html, "مستمر"));
  assert.ok(/<bdi dir="ltr" class="font-mono">sea-cafe<\/bdi>/.test(html) && html.includes('href="/menu/sea-cafe"'));
  assert.ok(/<dd[^>]*>[^<]*11:30[^<]*<\/dd>/.test(html), "08:30 UTC is 11:30 in Damascus, in Western digits (GC 10)");
  assert.ok(html.includes("#C0392B") && html.includes('src="https://media.example.test/cafes/7/logo.webp"'));
  assert.ok(0 < html.indexOf(">تغيير الخطة<") && html.indexOf(">تغيير الخطة<") < html.indexOf(">تفعيل الاشتراك<"), "newest first");
  assert.ok(html.includes("Paid 3 months in cash.\nReceipt 12.") && shown(html, "بواسطة مشرف حُذف حسابه"));
  assert.ok(/بواسطة <bdi dir="ltr">admin@example.test<\/bdi>/.test(html));
  const en = await page("/admin/cafes/7", "en");
  assert.ok(shown(en, "Billing history") && shown(en, "Running") && /Nov 2, 2026, 11:30/.test(en));
  // GC 5: the last paid day is a calendar day (no time zone moves it); 92 days left needs no warning.
  assert.ok(shown(en, "Paid until") && en.includes("Feb 10, 2027") && !shown(en, "92 days left") && !shown(en, "Overdue"));
});

test("the last paid days: a badge from 7 days down, 'overdue' after them; an expiry is logged by the system", async () => {
  Object.assign(fake.cafe!, { subscription_expires_on: "2026-11-13", days_left: 3 });
  assert.ok(shown(await page(), "بقي 3 أيام"));
  fake.cafe!.days_left = 0;
  assert.ok(shown(await page("/admin/cafes/7", "en"), "Ends today"));
  fake.cafe!.days_left = -2; // the nightly job has not run
  assert.ok(shown(await page(), "تجاوز تاريخ الانتهاء"));
  Object.assign(fake.cafe!, { is_active: false, days_left: null, subscription_end_at: "2026-11-13T21:10:00Z" });
  fake.events.unshift({ action: "expired", notes: "Paid until 2026-11-13.", performed_by_email: null, created_at: "2026-11-13T21:10:00Z" });
  const html = await page();
  assert.ok(shown(html, "انتهاء الاشتراك") && shown(html, "بواسطة النظام تلقائيًا") && shown(html, "بواسطة مشرف حُذف حسابه"), "the system, not a deleted admin");
  assert.equal(formWith(html, "expires_on").names.includes("change"), true, "an inactive cafe offers Activate, not Renew");
});

test("a new cafe shows no dates, the default color, no logo and no events", async () => {
  const html = await page("/admin/cafes/8");
  assert.ok(shown(html, "اشتراك موقوف") && shown(html, "اللون الافتراضي") && shown(html, "لا يوجد شعار") && shown(html, "لا توجد أحداث بعد."));
  assert.equal((html.match(/<dd[^>]*>—<\/dd>/g) ?? []).length, 3, "start, end and last paid day: none yet");
});

test("an unknown cafe or a malformed id shows the not-found page; malformed ids never reach Django", async () => {
  fake.cafe = null;
  assert.ok(notFoundShown(await page()));
  fake.calls = [];
  for (const id of ["abc", "0", "-1", "07", "1e1", "0x1F", "9007199254740993"]) assert.ok(notFoundShown(await page(`/admin/cafes/${id}`)), id);
  assert.deepEqual(fake.calls, []);
});

test("deactivate, then activate: the notes go to Django and the answer shows the new state and event", async () => {
  let html = await page();
  assert.equal(value(formWith(html, "change"), "change"), "deactivate", "an active cafe offers Deactivate");
  let res = await submit(PAGE, cookie, formWith(html, "change"), { notes: "لم يدفع هذا الشهر." });
  assert.deepEqual(actionState(res.html), { error: null, saved: true });
  assert.deepEqual(fake.bodies, [{ notes: "لم يدفع هذا الشهر." }]);
  html = await page();
  assert.ok(shown(html, "اشتراك موقوف") && html.includes("لم يدفع هذا الشهر.") && html.indexOf(">إيقاف الاشتراك<") < html.indexOf(">تغيير الخطة<"));
  assert.ok(/<textarea[^>]*dir="auto"/.test(html), "notes in either language");
  // An activation needs the last paid day (UC-ADMIN-004); the form proposes one month from today.
  const activate = formWith(html, "change");
  assert.match(value(activate, "expires_on") ?? "", /^\d{4}-\d{2}-\d{2}$/);
  res = await submit(PAGE, cookie, activate, { expires_on: "2027-01-31" });
  assert.deepEqual(actionState(res.html), { error: null, saved: true });
  assert.deepEqual(fake.bodies[1], { expires_on: "2027-01-31", notes: "" });
  assert.deepEqual(writes(), ["POST /admin/cafes/7/deactivate/", "POST /admin/cafes/7/activate/"]);
  assert.ok((await page("/admin/cafes/7", "en")).includes("Jan 31, 2027"));
});

test("renew: a later last paid day and notes go to Django; the page shows the new day and the event", async () => {
  const html = await page();
  const form = formWith(html, "expires_on"); // an active cafe: the renew form (Deactivate takes no date)
  assert.equal(form.names.includes("change"), false);
  const res = await submit(PAGE, cookie, form, { expires_on: "2027-05-10", notes: "دفع 3 أشهر." });
  assert.deepEqual(actionState(res.html), { error: null, saved: true });
  assert.deepEqual(fake.bodies, [{ expires_on: "2027-05-10", notes: "دفع 3 أشهر." }]);
  assert.deepEqual(writes(), ["POST /admin/cafes/7/renew/"]);
  const after = await page("/admin/cafes/7", "en");
  assert.ok(after.includes("May 10, 2027") && shown(after, "Subscription renewed") && shown(after, "Active subscription"));
});

test("renew refusals: each message at the date, the typing kept; an inactive cafe is told to activate", async () => {
  const form = formWith(await page(), "expires_on");
  const refusal = async (values: Record<string, string>) => actionState((await submit(PAGE, cookie, form, values)).html);
  assert.deepEqual(await refusal({ expires_on: "2027-02-10", notes: "x" }),
    { error: { form: null, fields: { expires_on: [{ key: "dateNotLater" }] } }, notes: "x", expiresOn: "2027-02-10" });
  assert.deepEqual(await refusal({ expires_on: "2026-01-01" }), { error: { form: null, fields: { expires_on: [{ key: "datePast" }] } }, notes: "", expiresOn: "2026-01-01" });
  assert.deepEqual(await refusal({ expires_on: "soon" }), { error: { form: null, fields: { expires_on: [{ key: "dateFormat" }] } }, notes: "", expiresOn: "soon" });
  assert.deepEqual(await refusal({ expires_on: "" }), { error: { form: null, fields: { expires_on: [{ key: "required" }] } }, notes: "", expiresOn: "" });
  fake.cafe!.is_active = false; // deactivated by another admin, or expired, after this page was opened
  assert.deepEqual(await refusal({ expires_on: "2027-05-10" }), { error: refused("renewInactive"), notes: "", expiresOn: "2027-05-10" });
  assert.equal(fake.events.length, 2);
});

test("subscription refusals: a stale page, notes over 500 characters; the notes are kept", async () => {
  const stale = formWith(await page(), "change"); // "deactivate", opened before another admin's change
  fake.cafe!.is_active = false;
  let state = actionState((await submit(PAGE, cookie, stale, { notes: "again" })).html);
  assert.deepEqual(state, { error: refused("alreadyInactive"), notes: "again" });
  const long = "x".repeat(501); // only a changed page can send this (maxLength 500)
  state = actionState((await submit(PAGE, cookie, formWith(await page(), "change"), { notes: long, expires_on: "2027-01-31" })).html);
  assert.deepEqual(state, { error: { form: null, fields: { notes: [{ key: "maxLength", values: { max: 500 } }] } }, notes: long, expiresOn: "2027-01-31" });
  assert.equal(fake.events.length, 2);
});

test("edit: the form starts from the cafe; a save sends all four fields, an unticked color as \"\"", async () => {
  const html = await page();
  const form = formWith(html, "slug");
  assert.deepEqual(["name_ar", "name_en", "slug", "plan", "custom_color", "primary_color"].map((n) => value(form, n)),
    ["مقهى البحر", "Sea Cafe", "sea-cafe", "pro", "on", "#C0392B"]);
  assert.ok(shown(html, "تغيير اسم العنوان يوقف كل رموز QR المطبوعة لهذا المقهى، فلا تحوّل العناوين القديمة إلى الجديد."));
  const res = await submit(PAGE, cookie, form, { name_ar: "مقهى الموج", slug: "wave-cafe", custom_color: null });
  assert.deepEqual(actionState(res.html), { error: null, saved: true });
  assert.deepEqual(fake.bodies, [{ name: { ar: "مقهى الموج", en: "Sea Cafe" }, slug: "wave-cafe", plan: "pro", primary_color: "" }]);
  const after = await page();
  assert.ok(after.includes('href="/menu/wave-cafe"') && shown(after, "اللون الافتراضي"));
  assert.deepEqual([value(formWith(after, "slug"), "custom_color"), value(formWith(after, "slug"), "primary_color")], [undefined, "#6f4e37"]);
  assert.equal(fake.events.length, 2, "same plan: no billing event");
});

test("edit: a downgrade over the limit is refused with its numbers; an allowed one writes the event", async () => {
  let state = actionState((await submit(PAGE, cookie, formWith(await page(), "slug"), { plan: "basic" })).html) as { error: unknown; values: { plan: string } };
  assert.deepEqual(state.error, { form: { key: "downgradeCategories", values: { plan: "Basic", count: 8, max: 5 } }, fields: {} });
  assert.equal(state.values.plan, "basic", "the choice is kept");
  fake.categories = 3;
  state = actionState((await submit(PAGE, cookie, formWith(await page(), "slug"), { plan: "basic" })).html) as { error: unknown; values: { plan: string } };
  assert.equal(state.error, null);
  const html = await page();
  assert.ok(html.includes("Plan changed from Pro to Basic.") && value(formWith(html, "slug"), "plan") === "basic");
});

test("edit refusals: each message at its field, the typing kept", async () => {
  const form = formWith(await page(), "slug");
  type Refusal = { error: { fields: object }; values?: object };
  let state = actionState((await submit(PAGE, cookie, form, { slug: "new-cafe" })).html) as Refusal;
  assert.deepEqual(state.error.fields, { slug: [{ key: "slugTaken" }] });
  state = actionState((await submit(PAGE, cookie, form, { slug: "bad slug", name_ar: " ", primary_color: "red" })).html) as Refusal;
  assert.deepEqual(state.error.fields, { "name.ar": [{ key: "required" }], slug: [{ key: "slugFormat" }], primary_color: [{ key: "colorFormat" }] });
  assert.deepEqual(state.values, { slug: "bad slug", name: { ar: " ", en: "Sea Cafe" }, plan: "pro", color: "red" });
});

test("reset link: one POST without a body; the link goes back to the dialog and the page data stays as it was", async () => {
  const html = await page();
  const dialog = html.split("<form").find((chunk) => chunk.includes(">إنشاء الرابط<"))!.split("</form>")[0];
  assert.ok(dialog.includes('<bdi dir="ltr" class="font-semibold">owner@example.test</bdi>'), "the dialog names the account");
  const res = await submit(PAGE, cookie, resetLinkForm(html));
  assert.deepEqual(actionState(res.html), { error: null, link: RESET_LINK });
  assert.deepEqual(writes(), ["POST /admin/cafes/7/password-reset-link/"]);
  assert.equal(fake.events.length, 2, "no billing event");
});

test("delete: Cancel comes first; one DELETE, then back to the list; a second try finds it gone", async () => {
  const html = await page();
  // React streams a dialog's form in a later chunk: find it by its button.
  const dialog = html.split("<form").find((chunk) => chunk.includes(">حذف نهائي<"))!.split("</form>")[0];
  assert.ok(dialog.includes(">مقهى البحر<") && dialog.includes(">sea-cafe<") && dialog.indexOf(">إلغاء<") < dialog.indexOf(">حذف نهائي<"));
  const form = deleteForm(html);
  const res = await submit(PAGE, cookie, form);
  assert.deepEqual([res.status, res.location], [303, "/admin/cafes"]);
  assert.deepEqual(writes(), ["DELETE /admin/cafes/7/"]);
  assert.deepEqual(actionState((await submit(PAGE, cookie, form)).html), { error: refused("notFound") }, "an old tab");
});

test("changed ids or changes never reach Django; a 403 from any dialog ends the session", async () => {
  const html = await page();
  const forms = [formWith(html, "change"), formWith(html, "expires_on"), formWith(html, "slug"), resetLinkForm(html), deleteForm(html)];
  for (const form of forms) {
    for (const id of ["7/../8", "0", "abc"]) {
      const state = actionState((await submit(PAGE, cookie, form, { id })).html) as { error: unknown };
      assert.deepEqual(state.error, refused("notFound"), id);
    }
  }
  const state = actionState((await submit(PAGE, cookie, forms[0], { change: "activate/../../8" })).html) as { error: unknown };
  assert.deepEqual(state.error, refused("notFound"));
  assert.deepEqual(writes(), []);
  fake.status = 403;
  for (const form of forms) {
    const res = await submit(PAGE, cookie, form);
    assert.deepEqual([res.status, res.location], [303, "/bff/auth/session-ended"]);
  }
});
