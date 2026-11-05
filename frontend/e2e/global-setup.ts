import { request } from "@playwright/test";
import { ADMIN_EMAIL, ADMIN_PASSWORD, BASE_URL, compose } from "./stack";

function manage(...args: string[]): void {
  compose(["exec", "-T", "backend", "python", "manage.py", ...args]);
}

/** Asks Nginx for /login until the whole chain (Nginx -> Next.js) answers 200. */
async function waitForSite(): Promise<void> {
  const client = await request.newContext({ baseURL: BASE_URL, ignoreHTTPSErrors: true });
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      const response = await client.get("/login").catch(() => null);
      if (response?.ok()) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`${BASE_URL}/login did not answer 200 within 60 seconds`);
  } finally {
    await client.dispose();
  }
}

/**
 * Runs once before all tests: builds the images from the current code, starts a fresh stack, and seeds
 * only what has no screen (deploy/README.md §5-§7). Everything else the tests create through the UI.
 * The returned function runs after all tests and deletes the stack with its volumes.
 */
export default async function globalSetup(): Promise<() => void> {
  compose(["down", "--volumes", "--remove-orphans"]); // leftovers of an interrupted run
  compose(["build", "backend", "frontend"]);
  compose(["run", "--rm", "certs"]);
  compose(["up", "--detach", "--wait", "nginx"]); // also starts db, backend and frontend

  manage("migrate", "--noinput");
  manage("createcachetable");
  manage("create_plans"); // the two plans of deploy/README.md §6
  // "-e NAME" without a value copies NAME from the docker client's environment, so the password is not
  // part of the command line.
  compose(
    ["exec", "-T", "-e", "DJANGO_SUPERUSER_PASSWORD", "backend",
      "python", "manage.py", "createsuperuser", "--noinput", "--email", ADMIN_EMAIL],
    { DJANGO_SUPERUSER_PASSWORD: ADMIN_PASSWORD },
  );

  await waitForSite();
  return () => compose(["down", "--volumes"]);
}
