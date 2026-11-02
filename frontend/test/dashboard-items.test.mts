/**
 * Integration tests of the Items screen (UC-OWNER-002, 004, 005, 006, 013; steps 10.6-10.8): the real
 * built app in front of a fake Django that copies the items API with DRF's texts. Forms are posted
 * like a browser without JavaScript; the reorder and the availability switch are called like the
 * page's JavaScript does.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { crc32, deflateSync } from "node:zlib";

import { actionState, callAction, type Form, formsOf, ownerCookie, shown, submit } from "./forms.mts";
import { type FakeDjango, startApp } from "./harness.mts";

const NEXT_PORT = 4150;
const DJANGO_PORT = 4151;
const SITE = `http://localhost:${NEXT_PORT}`;
const PAGE = `${SITE}/dashboard/items`;
const ACTIONS = "src/app/(app)/dashboard/items/actions.ts";
const MB = 1024 * 1024;

type Item = {
  id: number; category_id: number; name: { ar: string; en: string }; description: { ar: string; en: string };
  price: string; image_url: string; is_available: boolean; is_featured: boolean; is_new: boolean; sort_order: number;
};
const CATEGORIES = [
  { id: 1, name: { ar: "مشروبات", en: "Drinks" }, sort_order: 100, is_visible: true },
  { id: 2, name: { ar: "حلويات", en: "" }, sort_order: 200, is_visible: true },
];
const fake = {
  plan: "pro" as "pro" | "basic", active: true, categories: CATEGORIES, items: [] as Item[], nextId: 1,
  calls: [] as string[], bodies: [] as unknown[], uploads: [] as { path: string; fields: string[]; size: number }[],
};
const settings = () => ({
  name: { ar: "Test Cafe AR", en: "Test Cafe EN" }, slug: "test-cafe", primary_color: "", logo_url: "", is_active: fake.active,
  plan: fake.plan === "pro"
    ? { name: "pro", max_categories: null, max_items: null, allows_images: true, allows_branding: true }
    : { name: "basic", max_categories: 5, max_items: 2, allows_images: false, allows_branding: false },
});
function seed(categoryId: number, ...names: string[]) {
  for (const ar of names) {
    const last = Math.max(0, ...fake.items.filter((i) => i.category_id === categoryId).map((i) => i.sort_order));
    fake.items.push({
      id: fake.nextId++, category_id: categoryId, name: { ar, en: "" }, description: { ar: "", en: "" }, price: "10.00",
      image_url: "", is_available: true, is_featured: false, is_new: false, sort_order: last + 100,
    });
  }
}
// DRF DecimalField(max_digits=10, decimal_places=2, min_value=0), in its order.
function priceError(price: string) {
  if (!/^-?\d+(\.\d+)?$/.test(price.trim())) return "A valid number is required.";
  if ((price.split(".")[1] ?? "").length > 2) return "Ensure that there are no more than 2 decimal places.";
  if (Number(price) < 0) return "Ensure this value is greater than or equal to 0.";
  return null;
}

const fakeDjango: FakeDjango = async (req, path, body, answer, raw) => {
  fake.calls.push(`${req.method} ${path}`);
  if (path === "/dashboard/settings/") return answer(200, settings());
  if (!fake.active) return answer(403, { detail: "Your subscription is inactive. Please contact support." });
  if (path === "/dashboard/categories/") return answer(200, fake.categories);
  if (req.method !== "GET") fake.bodies.push(body);
  const data = body as unknown as Partial<Item> & { ordered_ids?: number[] };
  if (path === "/dashboard/items/" && req.method === "GET") {
    const rank = (i: Item) => CATEGORIES.findIndex((c) => c.id === i.category_id) * 1e6 + i.sort_order;
    return answer(200, [...fake.items].sort((a, b) => rank(a) - rank(b)));
  }
  if (path === "/dashboard/items/" && req.method === "POST") {
    const error = priceError(String(data.price));
    if (error) return answer(400, { price: [error] });
    if (fake.plan === "basic" && fake.items.length >= 2) {
      return answer(403, { detail: "Your Basic plan allows a maximum of 2 items. Upgrade to Pro for unlimited." });
    }
    seed(Number(data.category_id), data.name!.ar);
    Object.assign(fake.items.at(-1)!, {
      name: data.name, description: data.description, price: Number(data.price).toFixed(2),
      is_featured: data.is_featured, is_new: data.is_new,
    });
    return answer(201, fake.items.at(-1));
  }
  if (path === "/dashboard/items/reorder/") {
    const ids = data.ordered_ids!;
    const chosen = ids.map((id) => fake.items.find((i) => i.id === id));
    if (chosen.some((i) => !i)) return answer(404, { detail: "Not found." });
    if (new Set(chosen.map((i) => i!.category_id)).size > 1) return answer(400, { ordered_ids: ["Reorder must be within one category."] });
    const siblings = fake.items.filter((i) => i.category_id === chosen[0]!.category_id);
    if (siblings.length !== ids.length) return answer(400, { ordered_ids: ["The list must include every item of the category exactly once."] });
    ids.forEach((id, n) => (fake.items.find((i) => i.id === id)!.sort_order = (n + 1) * 100));
    return answer(200, ids.map((id) => fake.items.find((i) => i.id === id)));
  }
  const match = /^\/dashboard\/items\/(\d+)\/(availability\/|image\/)?$/.exec(path);
  const item = fake.items.find((i) => i.id === Number(match?.[1]));
  if (match?.[2] === "image/") {
    // UC-OWNER-006: multipart only; the "image" file; then the plan (A1), the item (A7), the size (A3) and the type (A2).
    const form = await new Request("http://fake/", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: new Uint8Array(raw) }).formData();
    const file = form.get("image");
    fake.uploads.push({ path, fields: [...form.keys()], size: file instanceof File ? file.size : -1 });
    if (!(file instanceof File) || !file.name) return answer(400, { image: ["No file was submitted."] });
    if (fake.plan !== "pro") return answer(403, { detail: "Item images require a Pro plan." });
    if (!item) return answer(404, { detail: "Not found." });
    if (file.size > 2 * MB) return answer(400, { detail: "Image must be under 2MB." });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!bytes.subarray(1, 4).equals(Buffer.from("PNG"))) return answer(400, { detail: "Only JPEG, PNG, and WebP images are allowed." });
    item.image_url = `https://media.example.test/cafes/1/items/${item.id}-${fake.uploads.length}.webp`;
    return answer(200, item);
  }
  if (!item) return answer(404, { detail: "Not found." });
  if (match?.[2] === "availability/") {
    item.is_available = data.is_available!;
    return answer(200, { id: item.id, is_available: item.is_available });
  }
  if (req.method === "PATCH") {
    const error = priceError(String(data.price));
    if (error) return answer(400, { price: [error] });
    if (Number(data.category_id) !== item.category_id) {
      item.sort_order = Math.max(0, ...fake.items.filter((i) => i.category_id === Number(data.category_id)).map((i) => i.sort_order)) + 100;
    }
    Object.assign(item, { ...data, category_id: Number(data.category_id), price: Number(data.price).toFixed(2) });
    return answer(200, item);
  }
  fake.items = fake.items.filter((i) => i !== item); // DELETE: soft delete in Django
  answer(204);
};

startApp({ nextPort: NEXT_PORT, djangoPort: DJANGO_PORT, django: fakeDjango });
beforeEach(() => Object.assign(fake, {
  plan: "pro", active: true, categories: CATEGORIES, items: [], nextId: 1, calls: [], bodies: [], uploads: [],
}));

const cookie = ownerCookie();
const page = async (query = "?category=1", lang = "ar") =>
  (await fetch(`${PAGE}${query}`, { headers: { Cookie: `${cookie}; lang=${lang}` } })).text();
const url = (query = "?category=1") => `${PAGE}${query}`;
const createForm = (html: string) => formsOf(html).find((f) => f.names.includes("price") && !f.names.includes("id"));
const rowForms = (html: string, id: number) => formsOf(html).filter((f) => f.fields.some(([n, v]) => n === "id" && v === String(id)));
const editForm = (html: string, id: number) => rowForms(html, id).find((f) => f.names.includes("price"))!;
const imageForm = (html: string, id: number) => rowForms(html, id).find((f) => f.names.includes("image"));
const deleteForm = (html: string, id: number) => rowForms(html, id).find((f) => !f.names.includes("price") && !f.names.includes("image"))!;
const writes = () => fake.calls.filter((call) => !call.startsWith("GET"));
const refused = (key: string) => ({ error: { form: { key }, fields: {} } });

/** A real PNG of side x side pixels; `padTo` adds a text chunk until the file has that many bytes. */
function png(side = 4, padTo = 0): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header.set([8, 2], 8); // 8 bits, RGB
  const pixels = deflateSync(Buffer.alloc(side * (side * 3 + 1), 0x80));
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", pixels)];
  const size = parts.reduce((n, p) => n + p.length, 0) + 12;
  if (padTo > size) parts.push(chunk("tEXt", Buffer.alloc(padTo - size - 12, 0x61)));
  return Uint8Array.from(Buffer.concat([...parts, chunk("IEND", Buffer.alloc(0))])); // a plain ArrayBuffer, as File wants
}
/** Posts an image form like a browser without JavaScript: its hidden inputs and the chosen file. */
async function upload(form: Form, file: File, values: Record<string, string> = {}) {
  const body = new FormData();
  for (const [name, value] of form.fields) if (name !== "image") body.append(name, values[name] ?? value);
  body.append("image", file);
  const res = await fetch(url(), { method: "POST", redirect: "manual", headers: { Cookie: cookie, Origin: SITE }, body });
  return { status: res.status, html: await res.text() };
}

test("without categories the page points to them; an inactive cafe makes no item call (GC 5)", async () => {
  fake.categories = [];
  let html = await page("");
  assert.ok(shown(html, "أضف قسمًا أولًا، فكل صنف ينتمي إلى قسم.") && shown(html, "الذهاب إلى الأقسام"));
  fake.categories = CATEGORIES;
  fake.active = false;
  fake.calls = [];
  html = await page();
  assert.ok(shown(html, "أصنافك محفوظة. يمكنك إدارتها من جديد بعد تفعيل الاشتراك."));
  assert.deepEqual(fake.calls, ["GET /dashboard/settings/"]);
});

test("one category at a time: ?category picks it, an unknown one opens the first; the plan's limit counts all items", async () => {
  fake.plan = "basic";
  seed(1, "قهوة");
  seed(2, "كنافة");
  const current = (html: string) => /<a[^>]*aria-current="true"[^>]*>([^<]*)<\/a>/.exec(html)?.[1];
  let html = await page("?category=2");
  assert.equal(current(html), "حلويات");
  assert.ok(shown(html, "كنافة") && !shown(html, "قهوة"));
  assert.equal(current(await page("?category=99")), "مشروبات");
  assert.ok(shown(html, "2 من أصل 2 في خطتك") && !createForm(html));
  assert.ok(shown(html, "تسمح خطة Basic بحد أقصى صنفين. رقِّ اشتراكك إلى Pro لعدد غير محدود."));
  html = await page("?category=1");
  assert.ok(shown(html, "صور الأصناف متاحة في خطة Pro فقط."), "Basic: why there is no image upload");
});

test("create sends every field as typed; a refused price keeps the typing", async () => {
  let result = await submit(url(), cookie, createForm(await page())!, {
    name_ar: "كنافة", name_en: "Kunafa", description_ar: "بالجبن", price: "12.5", is_featured: "on",
  });
  assert.deepEqual(fake.bodies.at(-1), {
    category_id: "1", name: { ar: "كنافة", en: "Kunafa" }, description: { ar: "بالجبن", en: "" },
    price: "12.5", is_featured: true, is_new: false,
  });
  assert.ok(shown(result.html, "12.50 ل.س"), "the answer shows the item with Django's price");
  result = await submit(url(), cookie, createForm(result.html)!, { name_ar: "شاي", price: "1.234" });
  const state = actionState(result.html) as { error: unknown; values: { price: string } };
  assert.deepEqual(state.error, { form: null, fields: { price: [{ key: "maxDecimals", values: { max: 2 } }] } });
  assert.equal(state.values.price, "1.234");
  assert.equal(fake.items.length, 1);
});

test("edit moves an item to the end of another category; an unticked box sends false; delete", async () => {
  seed(1, "قهوة");
  seed(2, "كنافة");
  fake.items[0].is_featured = true;
  const html = await page();
  const result = await submit(url(), cookie, editForm(html, 1), { category_id: "2", price: "13", is_featured: null });
  assert.deepEqual(actionState(result.html), { error: null, saved: true });
  assert.deepEqual([fake.items[0].category_id, fake.items[0].sort_order, fake.items[0].price, fake.items[0].is_featured], [2, 200, "13.00", false]);
  await submit(url("?category=2"), cookie, deleteForm(await page("?category=2"), 1));
  assert.deepEqual(fake.items.map((i) => i.name.ar), ["كنافة"]);
});

test("a drag reorders one category; the switch saves availability; bad arguments never reach Django", async () => {
  seed(1, "أ", "ب", "ج");
  seed(2, "د");
  const call = (name: string, ...args: unknown[]) => callAction(url(), cookie, ACTIONS, name, args);
  const saved = await call("reorderItems", [3, 1, 2]);
  assert.deepEqual(saved.result, { error: null });
  assert.ok(saved.payload.indexOf('"ج"') < saved.payload.indexOf('"أ"'), "the answer carries the fresh page");
  assert.deepEqual((await call("reorderItems", [3, 1, 2, 4])).result, refused("listChanged"));
  assert.deepEqual((await call("reorderItems", [3, 1])).result, refused("listChanged"));
  assert.deepEqual((await call("setItemAvailability", 2, false)).result, { error: null });
  assert.equal(fake.items[1].is_available, false);
  const before = writes().length;
  for (const args of [["2", false], [2, "no"], [0, true], [2.5, true]]) {
    assert.deepEqual((await call("setItemAvailability", ...args)).result, refused("notFound"), JSON.stringify(args));
  }
  assert.equal(writes().length, before);
});

test("an image goes to Django as the only field; Django's refusals come back as messages", async () => {
  seed(1, "قهوة");
  const form = imageForm(await page(), 1)!;
  let result = await upload(form, new File([png()], "photo.png", { type: "image/png" }));
  assert.deepEqual(actionState(result.html), { error: null, saved: true });
  assert.deepEqual(fake.uploads[0], { path: "/dashboard/items/1/image/", fields: ["image"], size: png().length });
  assert.ok(result.html.includes(`src="${fake.items[0].image_url}"`), "the answer shows the new image");
  const gif = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));
  result = await upload(form, new File([gif], "a.gif", { type: "image/gif" }));
  assert.deepEqual(actionState(result.html), refused("imageType"));
  result = await upload(form, new File([png()], "x.png"), { id: "../2" });
  assert.deepEqual(actionState(result.html), refused("notFound"));
  assert.equal(fake.uploads.length, 2, "a changed id never reaches Django");
});

test("Next takes an image of 2 MB (bodySizeLimit 3mb); a bigger body never reaches Django", async () => {
  seed(1, "قهوة");
  const form = imageForm(await page(), 1)!;
  let result = await upload(form, new File([png(4, 2 * MB)], "exactly-2mb.png", { type: "image/png" }));
  assert.deepEqual(actionState(result.html), { error: null, saved: true });
  result = await upload(form, new File([png(4, 2 * MB + 1)], "big.png", { type: "image/png" }));
  assert.deepEqual(actionState(result.html), refused("imageTooLarge"), "Django's own A3 message");
  result = await upload(form, new File([png(4, Math.round(3.5 * MB))], "huge.png", { type: "image/png" }));
  assert.equal(result.status, 500);
  assert.equal(fake.uploads.length, 2, "Next refused the body before the action ran");
});

test("Basic: no image upload; a stored image stays visible here, faded and marked (GC 7)", async () => {
  fake.plan = "basic";
  seed(1, "قهوة", "شاي");
  fake.items[0].image_url = "https://media.example.test/cafes/1/items/old.webp";
  const html = await page();
  assert.equal(imageForm(html, 1), undefined);
  assert.equal(/type="file"/.test(html), false);
  assert.ok(shown(html, "الصورة مخفية"));
  assert.ok([...html.matchAll(/<img[^>]*>/g)].some((m) => m[0].includes("old.webp") && m[0].includes("grayscale")));
  assert.ok(shown(html, "الصور التي أضفتها سابقًا محفوظة، لكنها مخفية عن الزبائن حتى ترقية الخطة."));
});
