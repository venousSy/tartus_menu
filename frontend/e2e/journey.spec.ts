import { readFile } from "node:fs/promises";
import { type Browser, type BrowserContext, devices, expect, type Locator, type Page, test } from "@playwright/test";
import jsQR from "jsqr";
import en from "../src/messages/en.json";
import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL } from "./stack";

// The whole product once, as its three kinds of users meet it (system_design.md §4 User Flows):
// the Super Admin opens a cafe, its owner builds the menu, a customer scans a table's QR code, and the
// changes of the owner and the admin reach the customer. Each test is one stage and needs the stages
// before it, so they run in order and stop at the first failure (test.describe.serial).

const CAFE = { slug: "e2e-cafe", ar: "مقهى الاختبار", en: "E2E Cafe" };
const OWNER = { email: "owner@e2e.test", password: "Tartus-Garden-42!" };
const HOT_DRINKS = { ar: "مشروبات ساخنة", en: "Hot drinks" };
const DESSERTS = { ar: "حلويات", en: "Desserts" };
const ESPRESSO = { ar: "إسبريسو", en: "Espresso", price: "15000" };
const TEA = { ar: "شاي", en: "Tea", price: "8000" };
const CHEESECAKE = { ar: "تشيز كيك", en: "Cheesecake", price: "30000" };
const RENAMED = "Double espresso";

/** One browser context per person: separate cookies, like three different phones or computers. */
async function newPerson(browser: Browser, options: Parameters<Browser["newContext"]>[0] = {}): Promise<Page> {
  const context = await browser.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true, ...options });
  return context.newPage();
}

/** The dashboards in English (the "lang" cookie of the language switch), so the tests can use the button texts. */
async function inEnglish(page: Page): Promise<Page> {
  await page.context().addCookies([{ name: "lang", value: "en", url: BASE_URL }]);
  return page;
}

async function logIn(page: Page, email: string, password: string, home: string): Promise<void> {
  await page.goto("/login");
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.getByRole("button", { name: en.Login.submit }).click();
  await page.waitForURL(`**${home}`);
}

/** Fills the two name inputs (NameFields) inside `scope`: a form or a dialog. */
async function fillNames(scope: Page | Locator, name: { ar: string; en: string }): Promise<void> {
  await scope.locator('input[name="name_ar"]').fill(name.ar);
  await scope.locator('input[name="name_en"]').fill(name.en);
}

/**
 * The create form under its heading. Each row's Rename or Edit dialog has inputs with the same names,
 * and its form is in the page even while the dialog is closed (DialogButton), so a field name alone is not enough.
 */
function createForm(page: Page, heading: string): Locator {
  return page.locator("form").filter({ has: page.getByRole("heading", { name: heading }) });
}

async function addCategory(page: Page, name: { ar: string; en: string }): Promise<void> {
  const form = createForm(page, en.Categories.newCategory);
  await fillNames(form, name);
  await form.getByRole("button", { name: en.Categories.add }).click();
  await expect(page.getByRole("listitem").filter({ hasText: name.en })).toBeVisible();
}

async function addItem(page: Page, item: { ar: string; en: string; price: string }): Promise<void> {
  const form = createForm(page, en.Items.newItem);
  await fillNames(form, item);
  await form.locator('input[name="price"]').fill(item.price);
  await form.getByRole("button", { name: en.Items.add }).click();
  await expect(page.getByRole("listitem").filter({ hasText: item.en })).toBeVisible();
}

/** Reads a QR code the way a phone camera does: from the image's pixels, not from the text beside it. */
async function scanQr(page: Page, alt: string): Promise<string> {
  const image = page.getByRole("img", { name: alt });
  await expect(image).toHaveJSProperty("complete", true);
  // Only the browser can decode the PNG; its pixels (RGBA) come back to Node for jsQR.
  const { width, height, rgba } = await image.evaluate((element: HTMLImageElement) => {
    const canvas = document.createElement("canvas");
    canvas.width = element.naturalWidth;
    canvas.height = element.naturalHeight;
    const context = canvas.getContext("2d")!;
    context.drawImage(element, 0, 0);
    return { width: canvas.width, height: canvas.height, rgba: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data) };
  });
  const code = jsQR(Uint8ClampedArray.from(rgba), width, height);
  expect(code, `no QR code found in "${alt}"`).not.toBeNull();
  return code!.data;
}

/**
 * Reloads until `check` passes: Django tells Next.js about a change right after saving it
 * (Global Convention 9), so the customer's page may need a moment.
 */
async function reloadUntil(page: Page, check: () => Promise<void>): Promise<void> {
  await expect(async () => {
    await page.reload();
    await check();
  }).toPass({ timeout: 15_000 });
}

test.describe.serial("from a new cafe to a customer's QR scan", () => {
  let admin: Page;
  let owner: Page;
  let customer: Page;
  let cafeUrl: string; // the admin's page of the cafe, /admin/cafes/<id>
  let menuUrl: string; // what table 2's QR code says

  test.beforeAll(async ({ browser }) => {
    admin = await inEnglish(await newPerson(browser));
    owner = await inEnglish(await newPerson(browser));
    // A phone, as after a real scan. The menu has its own language switch, so no cookie here.
    customer = await newPerson(browser, { ...devices["Pixel 7"] });
  });

  test.afterAll(async () => {
    const contexts: BrowserContext[] = [admin, owner, customer].filter(Boolean).map((page) => page.context());
    await Promise.all(contexts.map((context) => context.close()));
  });

  test("1. the Super Admin creates the cafe and activates it", async () => {
    // UC-AUTH-001, UC-ADMIN-001, UC-ADMIN-004
    await logIn(admin, ADMIN_EMAIL, ADMIN_PASSWORD, "/admin");
    await admin.goto("/admin/cafes/new");
    await admin.locator('input[name="slug"]').fill(CAFE.slug);
    await fillNames(admin, CAFE);
    await admin.locator('select[name="plan"]').selectOption("basic");
    await admin.locator('input[name="owner_email"]').fill(OWNER.email);
    await admin.locator('input[name="owner_password"]').fill(OWNER.password);
    await admin.getByRole("button", { name: en.AdminCreate.submit }).click();
    await admin.waitForURL(/\/admin\/cafes\/\d+$/);
    cafeUrl = admin.url();
    await expect(admin.getByText(en.AdminCafe.inactive, { exact: true })).toBeVisible();

    await admin.getByRole("button", { name: en.AdminCafe.activate }).click();
    await admin.getByRole("dialog").getByRole("button", { name: en.AdminCafe.activateConfirm, exact: true }).click();
    await expect(admin.getByText(en.AdminCafe.active, { exact: true })).toBeVisible();
    await expect(admin.getByText("Subscription activated")).toBeVisible(); // the billing log
  });

  test("2. the owner builds the menu and prints the QR codes", async () => {
    // UC-AUTH-001, UC-OWNER-001, -002, -005, -007, -008, -011
    await logIn(owner, OWNER.email, OWNER.password, "/dashboard");

    await owner.goto("/dashboard/categories");
    await addCategory(owner, HOT_DRINKS);
    await addCategory(owner, DESSERTS);

    await owner.goto("/dashboard/items"); // opens the first category, Hot drinks
    await addItem(owner, ESPRESSO);
    await addItem(owner, TEA);
    await owner.getByRole("link", { name: DESSERTS.en }).click();
    await owner.waitForURL(/category=\d+/);
    await addItem(owner, CHEESECAKE);

    // Tea is sold out today. The switch moves at once; the reload proves Django saved it.
    // A full page load, not the category link: a switch clicked while that link's page is still
    // loading shows the item twice (OBSERVATIONS.md 51).
    await owner.goto("/dashboard/items"); // the first category, Hot drinks
    const teaSwitch = owner.getByRole("switch", { name: `Available: ${TEA.en}` });
    await teaSwitch.click();
    await expect(teaSwitch).toHaveAttribute("aria-checked", "false");
    await owner.reload();
    await expect(teaSwitch).toHaveAttribute("aria-checked", "false");

    await owner.goto("/dashboard/qr");
    await owner.locator('input[name="table_count"]').fill("3");
    await owner.getByRole("button", { name: en.Qr.generate }).click();
    await expect(owner.getByRole("img", { name: /^QR code for table \d+$/ })).toHaveCount(3);

    const [download] = await Promise.all([
      owner.waitForEvent("download"),
      owner.getByRole("link", { name: en.Qr.downloadPdf }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const pdf = await readFile(await download.path());
    expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    menuUrl = await scanQr(owner, "QR code for table 2");
    expect(menuUrl).toBe(`${BASE_URL}/menu/${CAFE.slug}?table=2`);
  });

  test("3. a customer scans table 2 and reads the menu", async () => {
    // UC-GUEST-001: Arabic first, then the language switch; the unavailable item is not shown.
    await customer.goto(menuUrl);
    await expect(customer.getByRole("heading", { level: 1 })).toHaveText(CAFE.ar);
    // The table number is read in the browser, so seeing it also means the page is ready for clicks.
    await expect(customer.getByText("طاولة 2")).toBeVisible();

    await customer.getByRole("button", { name: "English" }).click();
    await expect(customer.getByRole("heading", { level: 1 })).toHaveText(CAFE.en);
    await expect(customer.getByText("Table 2")).toBeVisible();
    await expect(customer.getByRole("heading", { level: 2 })).toHaveText([HOT_DRINKS.en, DESSERTS.en]);
    await expect(customer.getByRole("heading", { level: 3 })).toHaveText([ESPRESSO.en, CHEESECAKE.en]);
    await expect(customer.getByText(TEA.en)).toHaveCount(0);
  });

  test("4. the owner renames an item and the customer sees it at once", async () => {
    // UC-OWNER-002 edit + Global Convention 9 (on-demand revalidation)
    await owner.goto("/dashboard/items");
    await owner.getByRole("listitem").filter({ hasText: ESPRESSO.en }).getByRole("button", { name: en.Items.edit }).click();
    const dialog = owner.getByRole("dialog");
    await dialog.locator('input[name="name_en"]').fill(RENAMED);
    await dialog.getByRole("button", { name: en.Forms.save }).click();
    await expect(dialog).toBeHidden();

    // The language choice is kept in the phone's browser, so the reload stays in English.
    await reloadUntil(customer, async () => {
      await expect(customer.getByRole("heading", { level: 3, name: RENAMED })).toBeVisible({ timeout: 1_000 });
    });
  });

  test("5. the Super Admin deactivates the cafe and the menu becomes unavailable", async () => {
    // UC-ADMIN-005, UC-GUEST-002
    await admin.goto(cafeUrl);
    await admin.getByRole("button", { name: en.AdminCafe.deactivate }).click();
    await admin.getByRole("dialog").getByRole("button", { name: en.AdminCafe.deactivateConfirm, exact: true }).click();
    await expect(admin.getByText(en.AdminCafe.inactive, { exact: true })).toBeVisible();

    await reloadUntil(customer, async () => {
      await expect(customer.getByText(en.Menu.unavailable)).toBeVisible({ timeout: 1_000 });
    });
    await owner.goto("/dashboard");
    await expect(owner.getByText(en.Dashboard.inactive)).toBeVisible();
  });
});
