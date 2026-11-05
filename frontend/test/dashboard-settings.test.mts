/**
 * Integration tests of the Settings screen (UC-OWNER-014 read, UC-OWNER-009 names and menu color,
 * UC-OWNER-010 logo; steps 10.10a-c): the real built app in front of a fake Django that copies the
 * settings API with DRF's texts. Forms are posted like a browser without JavaScript. The password
 * form calls /bff/auth/change-password from the browser; that route is tested in bff.test.mts.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { actionState, type Form, formsOf, ownerCookie, shown, submit } from "./forms.mts";
import { type FakeDjango, startApp } from "./harness.mts";

const NEXT_PORT = 4170;
const DJANGO_PORT = 4171;
const SITE = `http://localhost:${NEXT_PORT}`;
const PAGE = `${SITE}/dashboard/settings`;
const INACTIVE = { detail: "Your subscription is inactive. Please contact support." };

const fake = {
  plan: "pro" as "pro" | "basic", active: true,
  name: { ar: "مقهى التجربة", en: "Test Cafe" }, primary_color: "", logo_url: "",
  patches: [] as Record<string, unknown>[], uploads: [] as string[][],
};
const settings = () => ({
  name: fake.name, slug: "test-cafe", primary_color: fake.primary_color, logo_url: fake.logo_url, is_active: fake.active,
  plan: fake.plan === "pro"
    ? { name: "pro", max_categories: null, max_items: null, allows_images: true, allows_branding: true }
    : { name: "basic", max_categories: 5, max_items: 20, allows_images: false, allows_branding: false },
});
// BilingualNameField: "ar" required and not blank; DRF trims spaces. "en" has no rule to fake here.
function nameErrors({ ar }: { ar?: string; en?: string }) {
  if (ar === undefined) return { name: { ar: ["This field is required."] } };
  if (ar.trim() === "") return { name: { ar: ["This field may not be blank."] } };
  return null;
}

const fakeDjango: FakeDjango = async (req, path, body, answer, raw) => {
  if (path === "/dashboard/settings/" && req.method === "GET") return answer(200, settings()); // also when inactive (GC 5)
  if (path === "/dashboard/settings/") {
    // UC-OWNER-009 in DRF's order: active check (A5), fields (A3, A4), then the plan (A2).
    const data = body as unknown as { name?: { ar: string; en: string }; primary_color?: string };
    fake.patches.push(data);
    if (!fake.active) return answer(403, INACTIVE);
    const errors = {
      ...(data.name && nameErrors(data.name)),
      ...("primary_color" in data && !/^(#[0-9A-Fa-f]{6})?$/.test(String(data.primary_color))
        ? { primary_color: ["Enter a color in #RRGGBB format."] } : {}),
    };
    if (Object.keys(errors).length) return answer(400, errors);
    if ("primary_color" in data && fake.plan !== "pro") return answer(403, { detail: "Custom colors require a Pro plan." });
    if (data.name) fake.name = { ar: data.name.ar.trim(), en: data.name.en.trim() };
    if ("primary_color" in data) fake.primary_color = data.primary_color!;
    return answer(200, settings());
  }
  // POST settings/logo/ (UC-OWNER-010): active check (A5), the "image" file, the plan (A1), the type (A2).
  const form = await new Request("http://fake/", { method: "POST", headers: { "content-type": req.headers["content-type"]! }, body: new Uint8Array(raw) }).formData();
  fake.uploads.push([...form.keys()]);
  if (!fake.active) return answer(403, INACTIVE);
  const file = form.get("image");
  if (!(file instanceof File) || !file.name) return answer(400, { image: ["No file was submitted."] });
  if (fake.plan !== "pro") return answer(403, { detail: "Custom logos require a Pro plan." });
  if (!Buffer.from(await file.arrayBuffer()).subarray(1, 4).equals(Buffer.from("PNG"))) {
    return answer(400, { detail: "Only JPEG, PNG, and WebP images are allowed." });
  }
  fake.logo_url = `https://media.example.test/cafes/1/logo-${fake.uploads.length}.webp`;
  return answer(200, settings());
};

startApp({ nextPort: NEXT_PORT, djangoPort: DJANGO_PORT, django: fakeDjango });
beforeEach(() => Object.assign(fake, {
  plan: "pro", active: true, name: { ar: "مقهى التجربة", en: "Test Cafe" }, primary_color: "", logo_url: "", patches: [], uploads: [],
}));

const cookie = ownerCookie();
const page = async (lang = "ar") => (await fetch(PAGE, { headers: { Cookie: `${cookie}; lang=${lang}` } })).text();
const settingsForm = (html: string) => formsOf(html).find((f) => f.names.includes("name_ar"));
const logoForm = (html: string) => formsOf(html).find((f) => f.names.includes("image"));
const passwordForm = (html: string) => formsOf(html).find((f) => f.names.includes("old_password"));
const input = (html: string, name: string) => new RegExp(`<input[^>]*name="${name}"[^>]*>`).exec(html)?.[0];
const save = async (values: Record<string, string | null>, form?: Form) =>
  actionState((await submit(PAGE, cookie, form ?? settingsForm(await page())!, values)).html);
const refused = (key: string) => ({ error: { form: { key }, fields: {} } });

const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
const GIF = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64"));
/** Posts the logo form like a browser without JavaScript: its hidden inputs and the chosen file ("" = none chosen). */
async function upload(form: Form, file: File) {
  const body = new FormData();
  for (const [name, value] of form.fields) if (name !== "image") body.append(name, value);
  body.append("image", file);
  const res = await fetch(PAGE, { method: "POST", redirect: "manual", headers: { Cookie: cookie, Origin: SITE }, body });
  return actionState(await res.text());
}

test("Pro: the slug read-only, the names, the own-color box unticked over the default brown, the password form", async () => {
  let html = await page();
  assert.ok(shown(html, "test-cafe") && shown(html, "اسم عنوان القائمة"));
  assert.equal(input(html, "slug"), undefined, "the slug is not an input (only a Super Admin changes it)");
  assert.ok(input(html, "name_ar")!.includes('value="مقهى التجربة"') && input(html, "name_en")!.includes('value="Test Cafe"'));
  assert.equal(/\schecked/.test(input(html, "custom_color")!), false);
  assert.ok(input(html, "primary_color")!.includes('type="color"') && input(html, "primary_color")!.includes('value="#6f4e37"'));
  assert.equal(shown(html, "الألوان المخصصة متاحة في خطة Pro فقط."), false);
  assert.deepEqual(passwordForm(html)?.names, ["old_password", "new_password", "new_password_again"]);
  html = await page("en");
  assert.ok(shown(html, "Menu address name") && shown(html, "Use my own color on the customer menu") && shown(html, "Menu color"));
});

test("saves the names and an own color; an unticked box sends \"\" (the default theme)", async () => {
  assert.deepEqual(await save({ name_ar: "مقهى البحر", name_en: "Sea Cafe", custom_color: "on", primary_color: "#c0392b" }), { error: null, saved: true });
  assert.deepEqual(fake.patches.at(-1), { name: { ar: "مقهى البحر", en: "Sea Cafe" }, primary_color: "#c0392b" });
  const html = await page();
  assert.ok(/\schecked/.test(input(html, "custom_color")!) && input(html, "primary_color")!.includes('value="#c0392b"'));
  assert.deepEqual(await save({ custom_color: null }, settingsForm(html)), { error: null, saved: true });
  assert.deepEqual(fake.patches.at(-1), { name: { ar: "مقهى البحر", en: "Sea Cafe" }, primary_color: "" });
  assert.equal(fake.primary_color, "");
});

test("a refusal shows the message at its field and keeps the typing; nothing is saved", async () => {
  assert.deepEqual(await save({ name_ar: "  ", name_en: "Kept", custom_color: "on", primary_color: "#00aa00" }), {
    error: { form: null, fields: { "name.ar": [{ key: "required" }] } },
    values: { name: { ar: "  ", en: "Kept" }, color: "#00aa00" },
  });
  const state = await save({ custom_color: "on", primary_color: "red" }) as { error: { fields: object } }; // only a changed page sends this
  assert.deepEqual(state.error.fields, { primary_color: [{ key: "colorFormat" }] });
  assert.deepEqual([fake.name.ar, fake.primary_color], ["مقهى التجربة", ""]);
});

test("Basic: no color input but the plan note and the kept color; names are saved without primary_color (GC 7)", async () => {
  fake.plan = "basic";
  fake.primary_color = "#c0392b";
  const html = await page();
  assert.equal(input(html, "primary_color"), undefined);
  assert.equal(input(html, "custom_color"), undefined);
  assert.ok(shown(html, "الألوان المخصصة متاحة في خطة Pro فقط."));
  assert.ok(/لونك المحفوظ <bdi dir="ltr" class="font-mono">#c0392b<\/bdi> باقٍ/.test(html), "the color code reads left to right");
  assert.deepEqual(await save({ name_ar: "مقهى بيسك" }), { error: null, saved: true });
  assert.deepEqual(fake.patches.at(-1), { name: { ar: "مقهى بيسك", en: "Test Cafe" } });
  assert.equal(fake.primary_color, "#c0392b", "the stored color stays");
  const state = await save({ custom_color: "on", primary_color: "#000000" }) as { error: unknown }; // a changed page adds a color
  assert.deepEqual(state.error, refused("colorsNeedPro").error);
});

test("inactive: the profile is still read, the cafe forms are gone, the password form stays; old forms are refused", async () => {
  const before = await page();
  fake.active = false;
  const html = await page();
  assert.ok(shown(html, "test-cafe") && shown(html, "يمكنك تغيير إعداداتك من جديد بعد تفعيل الاشتراك."));
  assert.equal(settingsForm(html), undefined);
  assert.equal(logoForm(html), undefined);
  assert.ok(passwordForm(html), "auth endpoints never check the subscription (GC 5)");
  assert.deepEqual((await save({}, settingsForm(before)) as { error: unknown }).error, refused("subscriptionInactive").error);
  assert.deepEqual(await upload(logoForm(before)!, new File([PNG], "logo.png", { type: "image/png" })), refused("subscriptionInactive"));
});

test("a logo goes to Django as the only field and is shown; Django's refusals come back as messages", async () => {
  let html = await page();
  assert.ok(shown(html, "لا يوجد شعار بعد."));
  const file = /<input[^>]*type="file"[^>]*>/.exec(html)![0];
  assert.ok(file.includes('name="image"') && file.includes('accept="image/jpeg,image/png,image/webp"'), file);
  const form = logoForm(html)!;
  assert.deepEqual(await upload(form, new File([PNG], "logo.png", { type: "image/png" })), { error: null, saved: true });
  assert.deepEqual(fake.uploads, [["image"]]);
  const saved = fake.logo_url;
  html = await page();
  const img = [...html.matchAll(/<img[^>]*>/g)].map((m) => m[0]).find((tag) => tag.includes(`src="${saved}"`));
  assert.ok(img && img.includes('alt="الشعار الحالي"') && !img.includes("grayscale"), img);
  assert.deepEqual(await upload(form, new File([GIF], "a.gif", { type: "image/gif" })), refused("imageType"));
  assert.deepEqual(await upload(form, new File([], "")), { error: { form: null, fields: { image: [{ text: "No file was submitted." }] } } });
  assert.equal(fake.logo_url, saved, "refusals keep the logo");
});

test("Basic: no logo upload; a stored logo is faded and kept; an old form is refused (A1)", async () => {
  const proForm = logoForm(await page())!;
  fake.plan = "basic";
  let html = await page();
  assert.equal(logoForm(html), undefined);
  assert.ok(shown(html, "الشعار المخصص متاح في خطة Pro فقط.") && !shown(html, "شعارك محفوظ، لكن الزبائن لا يرونه حتى ترقية الخطة."));
  fake.logo_url = "https://media.example.test/cafes/1/logo-old.webp";
  html = await page();
  assert.ok([...html.matchAll(/<img[^>]*>/g)].some((m) => m[0].includes("logo-old.webp") && m[0].includes("opacity-50 grayscale")));
  assert.ok(shown(html, "شعارك محفوظ، لكن الزبائن لا يرونه حتى ترقية الخطة."));
  assert.deepEqual(await upload(proForm, new File([PNG], "logo.png", { type: "image/png" })), refused("logosNeedPro"));
});
