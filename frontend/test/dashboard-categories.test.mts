/**
 * Integration tests of the Categories screen (UC-OWNER-001, 003, 012; step 10.4-10.5): the real built
 * app in front of a fake Django that copies the categories API with DRF's texts. Forms are posted
 * like a browser without JavaScript; the drag reorder is called like the page's JavaScript does.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { actionState, callAction, formsOf, ownerCookie, shown, submit } from "./forms.mts";
import { type FakeDjango, startApp } from "./harness.mts";

const NEXT_PORT = 4130;
const DJANGO_PORT = 4131;
const PAGE = `http://localhost:${NEXT_PORT}/dashboard/categories`;
const ACTIONS = "src/app/(app)/dashboard/categories/actions.ts";
const INACTIVE = { detail: "Your subscription is inactive. Please contact support." };

type Category = { id: number; name: { ar: string; en: string }; sort_order: number; is_visible: boolean };
const fake = {
  plan: "pro" as "pro" | "basic", active: true, expired: false,
  categories: [] as Category[], nextId: 1, calls: [] as string[],
};
const settings = () => ({
  name: { ar: "Test Cafe AR", en: "Test Cafe EN" }, slug: "test-cafe", primary_color: "", logo_url: "", is_active: fake.active,
  plan: fake.plan === "pro"
    ? { name: "pro", max_categories: null, max_items: null, allows_images: true, allows_branding: true }
    : { name: "basic", max_categories: 2, max_items: 20, allows_images: false, allows_branding: false },
});
function seed(...names: string[]) {
  for (const ar of names) {
    fake.categories.push({ id: fake.nextId++, name: { ar, en: "" }, sort_order: fake.categories.length * 100 + 100, is_visible: true });
  }
}
// BilingualNameField: "ar" required and not blank (DRF trims spaces), each at most 100 characters.
function nameErrors(name: { ar?: string; en?: string } | undefined) {
  const ar = name?.ar?.trim() ?? "";
  if (!ar) return { name: { ar: [name?.ar === undefined ? "This field is required." : "This field may not be blank."] } };
  if (ar.length > 100) return { name: { ar: ["Ensure this field has no more than 100 characters."] } };
  return null;
}

const fakeDjango: FakeDjango = (req, path, body, answer) => {
  fake.calls.push(`${req.method} ${path}`);
  if (path === "/dashboard/settings/") return answer(200, settings());
  if (fake.expired) return answer(401, { detail: "Given token not valid for any token type" });
  if (!fake.active) return answer(403, INACTIVE);
  const data = body as unknown as { name?: { ar?: string; en?: string }; is_visible?: boolean; ordered_ids?: unknown };
  if (path === "/dashboard/categories/" && req.method === "GET") return answer(200, fake.categories);
  if (path === "/dashboard/categories/" && req.method === "POST") {
    const errors = nameErrors(data.name);
    if (errors) return answer(400, errors);
    if (fake.plan === "basic" && fake.categories.length >= 2) {
      return answer(403, { detail: "Your Basic plan allows a maximum of 2 categories. Upgrade to Pro for unlimited." });
    }
    seed(data.name!.ar!.trim());
    fake.categories.at(-1)!.name.en = data.name!.en?.trim() ?? "";
    return answer(201, fake.categories.at(-1));
  }
  if (path === "/dashboard/categories/reorder/" && req.method === "POST") {
    const ids = data.ordered_ids as number[];
    if (ids.some((id) => !fake.categories.some((c) => c.id === id))) return answer(404, { detail: "Not found." }); // A1
    if ([...ids].sort().join() !== fake.categories.map((c) => c.id).sort().join()) {
      return answer(400, { ordered_ids: ["The list must include every category exactly once."] }); // A2
    }
    fake.categories = ids.map((id, n) => ({ ...fake.categories.find((c) => c.id === id)!, sort_order: (n + 1) * 100 }));
    return answer(200, fake.categories);
  }
  const category = fake.categories.find((c) => path === `/dashboard/categories/${c.id}/`);
  if (!category) return answer(404, { detail: "Not found." });
  if (req.method === "PATCH") {
    if (data.name) {
      const errors = nameErrors(data.name);
      if (errors) return answer(400, errors);
      category.name = { ar: data.name.ar!.trim(), en: data.name.en?.trim() ?? "" };
    }
    if (data.is_visible !== undefined) category.is_visible = data.is_visible;
    return answer(200, category);
  }
  fake.categories = fake.categories.filter((c) => c !== category); // DELETE: soft delete in Django
  answer(204);
};

startApp({ nextPort: NEXT_PORT, djangoPort: DJANGO_PORT, django: fakeDjango });
beforeEach(() => Object.assign(fake, { plan: "pro", active: true, expired: false, categories: [], nextId: 1, calls: [] }));

const cookie = ownerCookie();
const page = async (lang = "ar") => (await fetch(PAGE, { headers: { Cookie: `${cookie}; lang=${lang}` } })).text();
const createForm = (html: string) => formsOf(html).find((f) => f.names.includes("name_ar") && !f.names.includes("id"));
const rowForms = (html: string, id: number) => formsOf(html).filter((f) => f.fields.some(([n, v]) => n === "id" && v === String(id)));
const writes = () => fake.calls.filter((call) => !call.startsWith("GET"));
const NOT_FOUND = { error: { form: { key: "notFound" }, fields: {} } };

test("an inactive cafe gets a note, and the page makes no category call (GC 5)", async () => {
  fake.active = false;
  const html = await page();
  assert.ok(shown(html, "أقسامك محفوظة. يمكنك إدارتها من جديد بعد تفعيل الاشتراك."));
  assert.equal(createForm(html), undefined);
  assert.deepEqual(fake.calls, ["GET /dashboard/settings/"]);
});

test("the list in menu order, the plan's count, and the limit text instead of the form at the limit", async () => {
  fake.plan = "basic";
  seed("مشروبات");
  let html = await page();
  assert.ok(shown(html, "مشروبات") && shown(html, "1 من أصل 2 في خطتك") && createForm(html));
  seed("حلويات");
  fake.categories[1].is_visible = false;
  html = await page();
  assert.ok(html.indexOf(">مشروبات<") < html.indexOf(">حلويات<"), "menu order");
  assert.ok(shown(html, "مخفي") && shown(html, "إظهار"), "the hidden one is marked and can be shown");
  assert.ok(shown(html, "2 من أصل 2 في خطتك"));
  assert.equal(createForm(html), undefined);
  assert.ok(shown(html, "تسمح خطة Basic بحد أقصى قسمين. رقِّ اشتراكك إلى Pro لعدد غير محدود."));
});

test("create sends both names; a refused name keeps the typing and names the field", async () => {
  let result = await submit(PAGE, cookie, createForm(await page())!, { name_ar: "مشروبات", name_en: "Drinks" });
  assert.equal(result.status, 200);
  assert.deepEqual(fake.categories.map((c) => c.name), [{ ar: "مشروبات", en: "Drinks" }]);
  assert.ok(shown(result.html, "مشروبات"), "the answer already shows it");
  result = await submit(PAGE, cookie, createForm(result.html)!, { name_ar: "   ", name_en: "Kept" });
  assert.deepEqual(actionState(result.html), {
    error: { form: null, fields: { "name.ar": [{ key: "required" }] } }, names: { ar: "   ", en: "Kept" },
  });
  assert.equal(fake.categories.length, 1);
});

test("rename, hide and delete go to the category's own path", async () => {
  seed("مشروبات", "حلويات");
  const html = await page();
  const forms = rowForms(html, 1);
  const rename = forms.find((f) => f.names.includes("name_ar"))!;
  const visibility = forms.find((f) => f.names.includes("is_visible"))!;
  const remove = forms.find((f) => !f.names.includes("name_ar") && !f.names.includes("is_visible"))!;
  await submit(PAGE, cookie, visibility);
  assert.equal(fake.categories[0].is_visible, false);
  const renamed = await submit(PAGE, cookie, rename, { name_ar: "مشروبات باردة", name_en: "Cold drinks" });
  assert.deepEqual(actionState(renamed.html), { error: null, saved: true }); // saved closes the dialog
  await submit(PAGE, cookie, remove);
  assert.deepEqual(fake.categories.map((c) => c.name.ar), ["حلويات"]);
  assert.deepEqual(writes(), ["PATCH /dashboard/categories/1/", "PATCH /dashboard/categories/1/", "DELETE /dashboard/categories/1/"]);
});

test("a changed id never reaches Django; an unknown one comes back as not found", async () => {
  seed("مشروبات");
  const remove = rowForms(await page(), 1).find((f) => !f.names.includes("name_ar") && !f.names.includes("is_visible"))!;
  for (const id of ["../../settings", "0", "1.5", "abc"]) {
    assert.deepEqual(actionState((await submit(PAGE, cookie, remove, { id })).html), NOT_FOUND, id);
  }
  assert.deepEqual(writes(), []);
  assert.deepEqual(actionState((await submit(PAGE, cookie, remove, { id: "99" })).html), NOT_FOUND);
  assert.deepEqual(writes(), ["DELETE /dashboard/categories/99/"]);
  assert.equal(fake.categories.length, 1);
});

test("a drag saves the whole list; a stale or malformed list is refused (UC-OWNER-003)", async () => {
  seed("أ", "ب", "ج");
  const call = (ids: unknown) => callAction(PAGE, cookie, ACTIONS, "reorderCategories", [ids]);
  const reorder = async (ids: unknown) => (await call(ids)).result;
  const saved = await call([3, 1, 2]);
  assert.deepEqual(saved.result, { error: null });
  assert.deepEqual(fake.categories.map((c) => [c.id, c.sort_order]), [[3, 100], [1, 200], [2, 300]]);
  // refresh(): the answer carries the page with the saved order, so the list shows Django's truth.
  assert.ok(saved.payload.indexOf('"ج"') < saved.payload.indexOf('"أ"'), "the answer carries the fresh page");
  assert.deepEqual(await reorder([3, 1]), { error: { form: { key: "listChanged" }, fields: {} } }); // A2
  assert.deepEqual(await reorder([3, 1, 9]), NOT_FOUND); // A1
  const before = fake.calls.length;
  for (const bad of ["3,1,2", [3, "1", 2], [3, 1, -2], null]) assert.deepEqual(await reorder(bad), NOT_FOUND, JSON.stringify(bad));
  assert.equal(fake.calls.length, before, "malformed lists never reach Django");
  assert.deepEqual(fake.categories.map((c) => c.id), [3, 1, 2]);
});

test("a write the subscription refuses, and a token Django rejects, which ends the session", async () => {
  const form = createForm(await page())!;
  fake.active = false;
  let result = await submit(PAGE, cookie, form, { name_ar: "قسم" });
  assert.deepEqual(actionState(result.html), {
    error: { form: { key: "subscriptionInactive" }, fields: {} }, names: { ar: "قسم", en: "" },
  });
  fake.active = true;
  fake.expired = true;
  result = await submit(PAGE, cookie, form, { name_ar: "قسم" });
  assert.equal(result.status, 303);
  assert.equal(result.location, "/bff/auth/session-ended");
});

test("English texts follow the language cookie", async () => {
  seed("مشروبات");
  const html = await page("en");
  for (const text of ["Categories", "1 category", "New category", "Arabic name", "Add category", "Rename", "Hide", "Delete"]) {
    assert.ok(shown(html, text), text);
  }
});
