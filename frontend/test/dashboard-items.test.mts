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
  price: string; image_url: string; thumbnail_url: string; is_available: boolean; is_featured: boolean; is_new: boolean;
  tags: string[]; variants: Variant[]; sort_order: number;
};
type Variant = { id?: number; name: { ar: string; en: string }; price: string };
// Django's MenuItem.Tag, in its order (GC 11).
const TAGS = ["vegan", "vegetarian", "gluten_free", "spicy", "contains_nuts", "contains_dairy"];
/** The tags answer of the fake Django: DRF's error for the first unknown code, else each code once in the fixed order. */
function checkTags(sent: unknown): { errors: object } | { tags: string[] } {
  if (!Array.isArray(sent)) return { errors: { tags: [`Expected a list of items but got type "${typeof sent}".`] } };
  const bad = sent.findIndex((tag) => !TAGS.includes(tag));
  if (bad >= 0) return { errors: { tags: { [bad]: [`"${sent[bad]}" is not a valid choice.`] } } };
  return { tags: TAGS.filter((tag) => sent.includes(tag)) };
}
/**
 * The variants answer of the fake Django (GC 10, UC-OWNER-002 A7 and A8): DRF's errors keyed by the
 * position of the refused variant; a price sent with variants is refused; else the stored list and
 * the item's price, which is the lowest variant price.
 */
function checkVariants(sent: Variant[], price: unknown): { errors: object } | { variants: Variant[]; price?: string } {
  const errors: Record<number, object> = {};
  sent.forEach((variant, n) => {
    const error = priceError(String(variant.price));
    if (!variant.name.ar) errors[n] = { name: { ar: ["This field may not be blank."] } };
    else if (error) errors[n] = { price: [error] };
  });
  if (Object.keys(errors).length > 0) return { errors: { variants: errors } };
  if (sent.length === 0) return { variants: [] };
  if (price !== undefined) return { errors: { price: ["An item with variants takes its price from them. Do not send price."] } };
  return {
    variants: sent.map((variant, n) => ({ id: 100 + n, name: variant.name, price: Number(variant.price).toFixed(2) })),
    price: Math.min(...sent.map((variant) => Number(variant.price))).toFixed(2),
  };
}
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
      image_url: "", thumbnail_url: "", is_available: true, is_featured: false, is_new: false, tags: [], variants: [],
      sort_order: last + 100,
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
    const sizes = checkVariants(data.variants ?? [], data.price);
    if ("errors" in sizes) return answer(400, sizes.errors);
    const error = sizes.price ? null : priceError(String(data.price));
    if (error) return answer(400, { price: [error] });
    const checked = checkTags(data.tags ?? []);
    if ("errors" in checked) return answer(400, checked.errors);
    if (fake.plan === "basic" && fake.items.length >= 2) {
      return answer(403, { detail: "Your Basic plan allows a maximum of 2 items. Upgrade to Pro for unlimited." });
    }
    seed(Number(data.category_id), data.name!.ar);
    Object.assign(fake.items.at(-1)!, {
      name: data.name, description: data.description, price: sizes.price ?? Number(data.price).toFixed(2),
      is_featured: data.is_featured, is_new: data.is_new, tags: checked.tags, variants: sizes.variants,
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
    // UC-OWNER-006: multipart only; the plan (A1), the item (A7), the "image" file, the size (A3) and the type (A2).
    const form = await new Request("http://fake/", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: new Uint8Array(raw) }).formData();
    const file = form.get("image");
    fake.uploads.push({ path, fields: [...form.keys()], size: file instanceof File ? file.size : -1 });
    if (fake.plan !== "pro") return answer(403, { detail: "Item images require a Pro plan." });
    if (!item) return answer(404, { detail: "Not found." });
    if (!(file instanceof File) || !file.name) return answer(400, { image: ["No file was submitted."] });
    if (file.size > 2 * MB) return answer(400, { detail: "Image must be under 2MB." });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!bytes.subarray(1, 4).equals(Buffer.from("PNG"))) return answer(400, { detail: "Only JPEG, PNG, and WebP images are allowed." });
    item.image_url = `https://media.example.test/cafes/1/items/${item.id}-${fake.uploads.length}.webp`;
    item.thumbnail_url = `https://media.example.test/cafes/1/items/${item.id}-${fake.uploads.length}-small.webp`;
    return answer(200, item);
  }
  if (!item) return answer(404, { detail: "Not found." });
  if (match?.[2] === "availability/") {
    item.is_available = data.is_available!;
    return answer(200, { id: item.id, is_available: item.is_available });
  }
  if (req.method === "PATCH") {
    const sizes = checkVariants(data.variants ?? item.variants, data.price); // PATCH: no "variants" keeps the list
    if ("errors" in sizes) return answer(400, sizes.errors);
    const error = sizes.price ? null : priceError(String(data.price));
    if (error) return answer(400, { price: [error] });
    const checked = checkTags(data.tags ?? item.tags); // PATCH: no "tags" keeps the list
    if ("errors" in checked) return answer(400, checked.errors);
    if (Number(data.category_id) !== item.category_id) {
      item.sort_order = Math.max(0, ...fake.items.filter((i) => i.category_id === Number(data.category_id)).map((i) => i.sort_order)) + 100;
    }
    Object.assign(item, {
      ...data, category_id: Number(data.category_id), price: sizes.price ?? Number(data.price).toFixed(2),
      tags: checked.tags, variants: sizes.variants,
    });
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
// By the name input, not the price: the edit form of an item with sizes has no "price" input (GC 10).
const editForm = (html: string, id: number) => rowForms(html, id).find((f) => f.names.includes("name_ar"))!;
const imageForm = (html: string, id: number) => rowForms(html, id).find((f) => f.names.includes("image"));
const deleteForm = (html: string, id: number) => rowForms(html, id).find((f) => !f.names.includes("name_ar") && !f.names.includes("image"))!;
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
    price: "12.5", is_featured: true, is_new: false, tags: [], variants: [],
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

/** `form` with these tag boxes ticked, as a browser sends them: one "tags" field per ticked box. */
const withTags = (form: Form, ...tags: string[]): Form => {
  const fields = [...form.fields.filter(([name]) => name !== "tags"), ...tags.map((tag): [string, string] => ["tags", tag])];
  return { fields, names: fields.map(([name]) => name) };
};
const tagsOf = (form: Form) => form.fields.filter(([name]) => name === "tags").map(([, tag]) => tag);
/** The codes of every tag box of a page, in page order (ticked or not). */
const tagBoxes = (html: string) =>
  [...html.matchAll(/<input[^>]*name="tags"[^>]*>/g)].map((m) => /\svalue="([^"]*)"/.exec(m[0])?.[1]);

test("tags (GC 11): a box per tag; the ticked ones go to Django as a list; the row shows them, and the edit form starts from them", async () => {
  const html = await page();
  const form = createForm(html)!;
  assert.deepEqual(tagBoxes(html), TAGS, "the create form (the only form with tags here): all six, in the fixed order");
  assert.deepEqual(tagsOf(form), [], "a new item starts without tags");
  assert.ok(html.includes("<legend") && shown(html, "الوسوم (اختياري)") && shown(html, "يحتوي مكسرات"));
  let result = await submit(url(), cookie, withTags(form, "vegan", "contains_nuts"), { name_ar: "سلطة", price: "9" });
  assert.deepEqual((fake.bodies.at(-1) as { tags: string[] }).tags, ["vegan", "contains_nuts"]);
  // The row: a dietary tag in green, a warning in red.
  assert.ok(/<span class="[^"]*bg-emerald-100[^"]*">نباتي صرف<\/span>/.test(result.html) && /<span class="[^"]*bg-red-100[^"]*">يحتوي مكسرات<\/span>/.test(result.html));
  assert.ok(shown(await page("?category=1", "en"), "Vegan") && shown(await page("?category=1", "en"), "Contains nuts"));
  const edit = editForm(await page(), 1);
  assert.deepEqual(tagsOf(edit), ["vegan", "contains_nuts"], "the item's boxes are ticked");
  // Unticking every box sends an empty list, which removes the tags (PATCH replaces the whole list).
  result = await submit(url(), cookie, edit, { tags: null });
  assert.deepEqual(actionState(result.html), { error: null, saved: true });
  assert.deepEqual([(fake.bodies.at(-1) as { tags: string[] }).tags, fake.items[0].tags], [[], []]);
});

/** The size rows of a form as a browser sends them: [name_ar, name_en, price] per row, in the order of N. */
const sizesOf = (form: Form) => {
  const rows: string[][] = [];
  for (const [name, value] of form.fields) {
    const match = /^variants\.(\d+)\.(name_ar|name_en|price)$/.exec(name);
    if (match) (rows[Number(match[1])] ??= ["", "", ""])[["name_ar", "name_en", "price"].indexOf(match[2])] = value;
  }
  return rows;
};

test("sizes (GC 10): the rows go to Django as a list, without a price; the row shows the lowest price with 'from'; the edit form starts from them", async () => {
  const form = createForm(await page())!;
  assert.deepEqual(sizesOf(form), [], "a new item starts with a price input and no size rows");
  // What the page sends after the owner added two rows: the price input is gone, the rows are numbered.
  let result = await submit(url(), cookie, form, {
    name_ar: "عصير", price: null,
    "variants.0.name_ar": "كبير", "variants.0.name_en": "Large", "variants.0.price": "45",
    "variants.1.name_ar": "صغير", "variants.1.price": "30",
  });
  const sent = fake.bodies.at(-1) as { price?: string; variants: Variant[] };
  assert.equal("price" in sent, false, "no price beside sizes (UC-OWNER-002 A8)");
  assert.deepEqual(sent.variants, [
    { name: { ar: "كبير", en: "Large" }, price: "45" }, { name: { ar: "صغير", en: "" }, price: "30" },
  ]);
  assert.ok(shown(result.html, "من 30 ل.س"), "the lowest price, not the first row's");
  const edit = editForm(await page(), 1);
  assert.deepEqual([sizesOf(edit), edit.names.includes("price")], [[["كبير", "Large", "45.00"], ["صغير", "", "30.00"]], false]);
  // Removing every row brings the price input back: the item gets one price again, and [] removes the sizes.
  result = await submit(url(), cookie, edit, {
    "variants.0.name_ar": null, "variants.0.name_en": null, "variants.0.price": null,
    "variants.1.name_ar": null, "variants.1.name_en": null, "variants.1.price": null, price: "20",
  });
  assert.deepEqual(actionState(result.html), { error: null, saved: true });
  assert.deepEqual([fake.items[0].price, fake.items[0].variants], ["20.00", []]);
  const html = await page();
  assert.ok(shown(html, "20 ل.س") && !shown(html, "من 20 ل.س"), "one price again, without 'from'");
});

test("sizes: a refused size comes back at its row (variants.N.price), the typing kept, nothing saved", async () => {
  seed(1, "قهوة");
  const result = await submit(url(), cookie, editForm(await page(), 1), {
    price: null, "variants.0.name_ar": "صغير", "variants.0.price": "30", "variants.1.name_ar": "كبير", "variants.1.price": "-5",
  });
  const state = actionState(result.html) as { error: unknown; values: { variants: Variant[] } };
  assert.deepEqual(state.error, { form: null, fields: { "variants.1.price": [{ key: "minValue", values: { min: 0 } }] } });
  assert.deepEqual(state.values.variants.map((variant) => variant.price), ["30", "-5"]);
  assert.deepEqual([fake.items[0].price, fake.items[0].variants], ["10.00", []]);
});

test("tags: a code Django does not know (a changed page) comes back as a message at the group, the ticks kept", async () => {
  seed(1, "قهوة");
  const result = await submit(url(), cookie, withTags(editForm(await page(), 1), "vegan", "halal"));
  const state = actionState(result.html) as { error: unknown; values: { tags: string[] } };
  assert.deepEqual(state.error, { form: null, fields: { "tags.1": [{ text: '"halal" is not a valid choice.' }] } });
  assert.deepEqual(state.values.tags, ["vegan", "halal"]);
  assert.deepEqual(fake.items[0].tags, [], "nothing was saved");
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
  assert.ok(result.html.includes(`src="${fake.items[0].thumbnail_url}"`), "the list row shows the small copy");
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
  fake.items[0].thumbnail_url = fake.items[0].image_url; // uploaded before thumbnails: Django sends the full image
  const html = await page();
  assert.equal(imageForm(html, 1), undefined);
  assert.equal(/type="file"/.test(html), false);
  assert.ok(shown(html, "الصورة مخفية"));
  assert.ok([...html.matchAll(/<img[^>]*>/g)].some((m) => m[0].includes("old.webp") && m[0].includes("grayscale")));
  assert.ok(shown(html, "الصور التي أضفتها سابقًا محفوظة، لكنها مخفية عن الزبائن حتى ترقية الخطة."));
});
