# End-to-end tests

These tests run the whole product in a real browser (Chromium, through Playwright): Nginx with HTTPS,
Next.js, Django and PostgreSQL, all from the current code. They are separate from `npm test`, which runs
the frontend against a fake Django.

- `smoke.spec.ts`: the login page opens through Nginx over HTTPS.
- `journey.spec.ts`: one cafe from start to end, in five stages that run in order. The Super Admin
  creates and activates the cafe, the owner builds the menu and prints the QR codes, a customer on a
  phone scans table 2, the owner renames an item, and the admin deactivates the cafe.

## Before the first run

1. Docker Desktop is running (`docker info` answers).
2. In `frontend/`: `npm ci`, then `npx playwright install chromium` (downloads the browser once,
   outside the repository).
3. Port 4243 on 127.0.0.1 is free. Nothing else is needed: no `.env` file, no local database.

## Run

From `frontend/`:

```bash
npm run e2e
```

The first run builds both images and takes about 11 minutes. Later runs reuse Docker's layer cache:
about 2 minutes to start and seed the stack, then less than a minute of tests.

What happens (`global-setup.ts`):

1. A separate Compose project, `tartus-menu-e2e`, is started from `compose.yaml` plus
   `compose.e2e.yaml`. It has its own volumes, so it never touches your development database or a
   local production-like stack.
2. A self-signed certificate for `localhost` is made, and Nginx listens on https://localhost:4243.
3. Migrations, the cache table, the two plans and a Super Admin are created, as in
   `deploy/README.md` §5-§7. Everything else the tests create through the screens.
4. After the tests, the stack is deleted with its volumes.

All values in `e2e.env` and `stack.ts` are throwaway values for this test stack only. Never reuse them
anywhere else.

## When a test fails

- `npx playwright show-report` opens the HTML report (`playwright-report/`).
- Each failed test keeps a trace in `test-results/`. Open it with
  `npx playwright show-trace test-results/<folder>/trace.zip`: every step, with the page, network
  and console at that moment.
- The stages of the journey depend on each other: after a failure the later stages are skipped.

If a run is interrupted (Ctrl+C), the stack may keep running. The next run removes it first, or remove
it yourself from the repository root:

```bash
docker compose --project-name tartus-menu-e2e --env-file frontend/e2e/e2e.env --file compose.yaml --file frontend/e2e/compose.e2e.yaml down --volumes --remove-orphans
```

## In CI

The `e2e` job in `.github/workflows/ci-cd.yml` runs `npm run e2e` on every pull request into `main`
and on every push to `main`, after the backend and frontend tests. The deploy waits for it. When it
fails, the report and the traces are uploaded as the `playwright-report` artifact of the run.
