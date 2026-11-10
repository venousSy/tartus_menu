/**
 * Integration tests of the QR codes screen (UC-OWNER-007 generate, 011 preview; step 10.9) and of the
 * PDF route GET /bff/dashboard/qr-pdf (UC-OWNER-008, decision D7): the real built app in front of a
 * fake Django that copies the QR API with DRF's texts. The generate form is posted like a browser
 * without JavaScript.
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { actionState, formsOf, ownerCookie, shown, submit } from "./forms.mts";
import { type FakeDjango, startApp } from "./harness.mts";

const NEXT_PORT = 4160;
const DJANGO_PORT = 4161;
const SITE = `http://localhost:${NEXT_PORT}`;
const PAGE = `${SITE}/dashboard/qr`;
const PDF = `${SITE}/bff/dashboard/qr-pdf`;

type Table = { id: number; table_number: number; qr_token: string; is_active: boolean };
const fake = {
  active: true, tables: [] as Table[], pdf: "ok" as "ok" | "unauthorized" | "error",
  calls: [] as string[], bodies: [] as unknown[], pdfAccepts: [] as string[],
};
const settings = () => ({
  name: { ar: "Test Cafe AR", en: "Test Cafe EN" }, slug: "test-cafe", primary_color: "", logo_url: "", is_active: fake.active,
  plan: { name: "pro", max_categories: null, max_items: null, allows_images: true, allows_branding: true },
});
/** Django's sync_tables: tables 1 to `count` are active; a table keeps its code (A3); the rest are kept, inactive (A4). */
function syncTables(count: number) {
  for (let n = 1; n <= count; n++) {
    const table = fake.tables.find((t) => t.table_number === n);
    if (table) table.is_active = true;
    else fake.tables.push({ id: fake.tables.length + 1, table_number: n, qr_token: crypto.randomUUID(), is_active: true });
  }
  for (const table of fake.tables) if (table.table_number > count) table.is_active = false;
}
// The answer of generate and preview: the active tables in order, each with its address and image.
const qrCodes = () => {
  const active = fake.tables.filter((t) => t.is_active).sort((a, b) => a.table_number - b.table_number);
  return {
    table_count: active.length,
    tables: active.map((t) => ({
      id: t.id, table_number: t.table_number, url: `https://menu.example.test/t/${t.qr_token}`, // GC 4: the short link
      qr_token: t.qr_token, qr_image_url: "data:image/png;base64,iVBORw0KGgo=",
    })),
  };
};

const fakeDjango: FakeDjango = (req, path, body, answer) => {
  fake.calls.push(`${req.method} ${path}`);
  if (path === "/dashboard/settings/") return answer(200, settings());
  if (!fake.active) return answer(403, { detail: "Your subscription is inactive. Please contact support." });
  if (req.method !== "GET") fake.bodies.push(body);
  if (path === "/dashboard/qr/preview/") return answer(200, qrCodes());
  if (path === "/dashboard/qr/generate/") {
    // DRF IntegerField(min_value=1, max_value=200): "12.0" is 12; then sync_tables.
    const text = String(body.table_count).trim().replace(/\.0*$/, "");
    if (!/^-?\d+$/.test(text)) return answer(400, { table_count: ["A valid integer is required."] });
    const count = Number(text);
    if (count > 200) return answer(400, { table_count: ["Ensure this value is less than or equal to 200."] });
    if (count < 1) return answer(400, { table_count: ["Ensure this value is greater than or equal to 1."] });
    syncTables(count);
    return answer(200, qrCodes());
  }
  // download-pdf. DRF's content negotiation runs first: the view has only the JSON renderer (obs 16).
  const accept = req.headers.accept ?? "";
  fake.pdfAccepts.push(accept);
  if (fake.pdf === "unauthorized") return answer(401, { detail: "Given token not valid for any token type" });
  if (fake.pdf === "error") return answer(500);
  if (accept && !/application\/json|\*\/\*/.test(accept)) return answer(406, { detail: "Could not satisfy the request Accept header." });
  const active = qrCodes().tables;
  if (active.length === 0) return answer(400, { detail: "Please generate QR codes first." }); // A1
  answer(200, `%PDF-1.4\n% fake: ${active.map((t) => `table ${t.table_number}`).join(", ")}\n%%EOF\n`, {
    "Content-Type": "application/pdf", "Content-Disposition": 'attachment; filename="qrcodes.pdf"',
  });
};

startApp({ nextPort: NEXT_PORT, djangoPort: DJANGO_PORT, django: fakeDjango });
beforeEach(() => Object.assign(fake, { active: true, tables: [], pdf: "ok", calls: [], bodies: [], pdfAccepts: [] }));

const cookie = ownerCookie();
const page = async (lang = "ar") => (await fetch(PAGE, { headers: { Cookie: `${cookie}; lang=${lang}` } })).text();
const generateForm = (html: string) => formsOf(html).find((f) => f.names.includes("table_count"))!;
const countInput = (html: string) => /<input[^>]*name="table_count"[^>]*>/.exec(html)![0];
const qrImages = (html: string) => [...html.matchAll(/<img[^>]*alt="رمز QR للطاولة (\d+)"[^>]*>/g)].map((m) => Number(m[1]));
const pdf = (headers: Record<string, string> = { Cookie: cookie }) => fetch(PDF, { headers, redirect: "manual" });

test("no tables yet: the empty note, an empty numeric input and no PDF link", async () => {
  const html = await page();
  assert.ok(shown(html, "لا توجد رموز QR بعد. أدخل عدد الطاولات ثم أنشئ الرموز."));
  const input = countInput(html);
  assert.ok(input.includes('inputMode="numeric"') && /\srequired(=|\s|\/?>)/.test(input) && input.includes('value=""'), input);
  assert.equal(html.includes('href="/bff/dashboard/qr-pdf"'), false);
  assert.deepEqual(qrImages(html), []);
});

test("generate sends the count as typed; the page shows every table's code and address", async () => {
  const result = await submit(PAGE, cookie, generateForm(await page()), { table_count: "3" });
  assert.deepEqual(actionState(result.html), { error: null });
  assert.deepEqual(fake.bodies, [{ table_count: "3" }]);
  let html = await page();
  assert.deepEqual(qrImages(html), [1, 2, 3]);
  const table2 = fake.tables.find((t) => t.table_number === 2)!;
  assert.ok(shown(html, "3 طاولات") && shown(html, "طاولة 2") && shown(html, `https://menu.example.test/t/${table2.qr_token}`));
  assert.ok(/<span dir="ltr"[^>]*>https:\/\/menu\.example\.test/.test(html), "addresses read left to right");
  assert.ok(countInput(html).includes('value="3"'), "the input shows the current count");
  assert.ok(html.includes('href="/bff/dashboard/qr-pdf"') && shown(html, "تنزيل ملف PDF للطباعة"));
  html = await page("en");
  assert.ok(shown(html, "3 tables") && shown(html, "Table 1") && shown(html, "Number of tables") && shown(html, "Download the PDF for printing"));
  assert.ok(/<img[^>]*alt="QR code for table 1"/.test(html));
});

test("a refused count shows the message at the field and keeps the typing; nothing changes", async () => {
  syncTables(3);
  const html = await page();
  for (const [typed, expected] of [
    ["0", { key: "minValue", values: { min: 1 } }],
    ["201", { key: "maxValue", values: { max: 200 } }],
    ["abc", { key: "invalidInteger" }],
    ["2.5", { key: "invalidInteger" }],
  ] as const) {
    const result = await submit(PAGE, cookie, generateForm(html), { table_count: typed });
    assert.deepEqual(actionState(result.html), { error: { form: null, fields: { table_count: [expected] } }, tableCount: typed }, typed);
  }
  assert.deepEqual(qrImages(await page()), [1, 2, 3]);
});

test("a smaller count hides the tables above it (A4); a larger one brings them back with their old codes (A3)", async () => {
  syncTables(3);
  const token3 = fake.tables[2].qr_token;
  await submit(PAGE, cookie, generateForm(await page()), { table_count: "2" });
  const html = await page();
  assert.deepEqual(qrImages(html), [1, 2]);
  assert.ok(shown(html, "طاولتان"));
  await submit(PAGE, cookie, generateForm(html), { table_count: "4" });
  assert.deepEqual(qrImages(await page()), [1, 2, 3, 4]);
  assert.equal(fake.tables.find((t) => t.table_number === 3)!.qr_token, token3, "table 3 kept its code");
});

test("an inactive cafe sees why, without the form, and the page makes no QR call (GC 5)", async () => {
  fake.active = false;
  const html = await page();
  assert.ok(shown(html, "طاولاتك ورموز QR محفوظة. يمكنك إدارتها من جديد بعد تفعيل الاشتراك."));
  assert.equal(html.includes('name="table_count"'), false);
  assert.deepEqual(fake.calls, ["GET /dashboard/settings/"]);
});

test("the PDF route passes Django's file on with its name, never cached, asked for as JSON (obs 16)", async () => {
  syncTables(2);
  const res = await pdf();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-disposition"), 'attachment; filename="qrcodes.pdf"');
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = await res.text();
  assert.ok(body.startsWith("%PDF") && body.includes("table 1, table 2"), body);
  assert.deepEqual(fake.pdfAccepts, ["application/json"]);
});

test("PDF refusals: back to the page, to /login, to session-ended, or a server error", async () => {
  const where = async (headers?: Record<string, string>) => {
    const res = await pdf(headers);
    return [res.status, res.headers.get("location")];
  };
  assert.deepEqual(await where(), [307, "/dashboard/qr"], "no tables (A1): the page explains");
  syncTables(1);
  fake.active = false;
  assert.deepEqual(await where(), [307, "/dashboard/qr"], "inactive (A2): the page explains");
  fake.active = true;
  assert.deepEqual(await where({}), [307, "/login"], "no session");
  fake.pdf = "unauthorized";
  assert.deepEqual(await where(), [307, "/bff/auth/session-ended"], "token rejected");
  fake.pdf = "error";
  assert.equal((await pdf()).status, 500, "a Django error is not passed on as a file");
});
