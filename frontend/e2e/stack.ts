import { execFileSync } from "node:child_process";
import path from "node:path";

/** The test site: Nginx of the e2e stack (compose.e2e.yaml publishes it on this port). */
export const BASE_URL = "https://localhost:4243";

/** The Super Admin that global-setup.ts creates. Throwaway values, like everything in e2e.env. */
export const ADMIN_EMAIL = "admin@e2e.test";
export const ADMIN_PASSWORD = "e2e-Admin-pass-1";

const REPO_ROOT = path.resolve(__dirname, "../..");

// A separate project name keeps the test containers and volumes apart from any other local stack.
const COMPOSE = [
  "compose",
  "--project-name", "tartus-menu-e2e",
  "--env-file", "frontend/e2e/e2e.env",
  "--file", "compose.yaml",
  "--file", "frontend/e2e/compose.e2e.yaml",
];

/**
 * Runs one `docker compose` command for the e2e stack and shows its output. Throws when the command
 * fails, which stops the test run. `env` adds variables for the docker client only (see global-setup.ts).
 */
export function compose(args: string[], env: Record<string, string> = {}): void {
  execFileSync("docker", [...COMPOSE, ...args], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
}
