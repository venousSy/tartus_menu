# Frontend (Next.js)

The Next.js app of the Tartus Smart Digital Menu. It serves three parts:

- the public menu that customers open from a QR code, `/menu/<slug>` (a PWA that also works offline);
- the cafe owner's dashboard, `/dashboard`;
- the Super Admin pages, `/admin`.

The browser never calls Django directly. The Next.js server is a BFF (backend for frontend): it calls the
Django API under `/api/v1/` and keeps the JWT tokens in HttpOnly cookies (`docs/system_design.md` §3.6).

## Requirements

- Node.js 24 and npm. Install with `npm ci`, which uses `package-lock.json` exactly.
- For the dashboards: the Django backend running on `http://127.0.0.1:8000` (see `backend/.env.example`).

## Setup

1. Copy `.env.example` to `.env.local` and fill it in. Never commit `.env.local`.
2. `npm ci`
3. `npm run dev`, then open http://localhost:3000. The bare domain `/` sends you to `/login`.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Development server with hot reload on port 3000. |
| `npm run build` then `npm start` | Production build and server, as in the Docker image. |
| `npm run lint` | ESLint. |
| `npx tsc --noEmit` | Type check. Run it after a build: it reads the route types that `next build` generates. |
| `npm test` | Builds the app, then runs the integration tests in `test/` against a fake Django (no backend needed). |
| `npm run e2e` | The whole product in a real browser, through Docker. See `e2e/README.md`. |

CI (`.github/workflows/ci-cd.yml`) runs `npm audit --omit=dev`, lint, `npm test`, the type check and the
end-to-end tests on every pull request into `main`.

## Where things are

| Path | Contents |
|---|---|
| `src/app/(customer)/` | The public menu `/menu/[slug]` with its web app manifest, and `/`, which redirects to `/login`. |
| `src/app/(app)/` | `/login`, the owner dashboard `/dashboard/*` and the Super Admin pages `/admin/*`. |
| `src/app/bff/` | Server routes the browser calls: login, logout, password change, session end, QR codes PDF. |
| `src/app/internal/revalidate/` | `POST` from Django after every menu change; rebuilds the cached menu pages (§3.5). |
| `src/proxy.ts` | Runs before the signed-in pages and the BFF routes (not the customer menu): refreshes an expired access token and sends each visitor to the page of their role, or to `/login`. |
| `src/i18n/`, `src/messages/` | Arabic (the default) and English. The language comes from the `lang` cookie, not the URL. |
| `src/lib/server/` | Server-only code: the session cookies, the token refresh and the calls to Django. |
| `src/lib/` | Shared helpers: Django error texts to message keys, roles, plans, colors, languages. |
| `public/sw.js` | The service worker that keeps the last menu a customer opened for offline use. |

## Production

The app runs as a Docker image (`Dockerfile`) in the Compose stack behind Nginx on one VPS, not on Vercel.
CI builds the image and pushes it to GitHub Container Registry. The runbook is `deploy/README.md`.
