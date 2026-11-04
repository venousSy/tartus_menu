import { expect, test } from "@playwright/test";

test("the login page opens through Nginx over HTTPS", async ({ page }) => {
  const response = await page.goto("/login");

  expect(response?.status()).toBe(200);
  // Only Nginx adds this header, so the page really came through the proxy.
  expect(response?.headers()["strict-transport-security"]).toBe("max-age=31536000");
  await expect(page.locator('input[name="email"]')).toBeVisible();
  await expect(page.locator('input[name="password"]')).toBeVisible();
});
