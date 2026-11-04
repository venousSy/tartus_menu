import { defineConfig, devices } from "@playwright/test";
import { BASE_URL } from "./e2e/stack";

// End-to-end tests: a real Chromium against the real stack (Nginx, Next.js, Django, PostgreSQL), started
// by e2e/global-setup.ts. Run with `npm run e2e`. The fake-Django tests in test/ stay under `npm test`.
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One shared database: the tests run one after another, in file order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: BASE_URL,
    // The stack uses a self-signed certificate (compose.e2e.yaml), which no browser trusts.
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
