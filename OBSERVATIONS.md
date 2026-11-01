# Observations Backlog

Known problems noticed while building the project and deliberately left unchanged
(AGENTS.md Section 9, "Observations (not changed)"). Ask "fix observation N" to work on one.

Rules for this file:
- Numbers are stable: never renumber, never reuse a number. A new observation gets the next free number.
- Add a new observation in the same commit as the step that found it, and list this file in that step's Changes table.
- When an observation is fixed, move it to "Fixed" and say where (commit or PR).

## Open

- **3.** `docs/code_overview.md` line 761 still shows the login error with a final period (use_cases.md was fixed). Doc change = its own turn.
- **6.** `backend/menu/views.py` line 16 has trailing spaces (from the user's own edit; left as is).
- **7.** The plan-limit message reads "maximum of 1 categories" when a limit is 1 (fine for the real Basic limit 5).
- **8.** Mixed line endings in the working tree because of `core.autocrlf`; a `.gitattributes` with `* text=auto eol=lf` would make it uniform.
- **9.** use_cases.md UC-AUTH-003 does not mention the logout ownership rule (another user's token -> 400), which the code and tests enforce.
- **13.** `docs/code_overview.md` (tracked in git) still says the app URL files are not built (lines 70, 288, 306, 382, 963). Doc change = its own turn.
- **14.** `core/revalidation.py` has no direct tests for its URL, the `X-Revalidate-Secret` header, the 2-second timeout or the error logging (system_design.md 3.5). `menu/tests.py` covers only the payload and the after-commit timing.
- **15.** AGENTS.md Section 3 still says to list remaining work under "Queued next", but the Section 6 footer has "Next:" (the user's own file; never edit it unless asked).
- **16.** `GET qr/download-pdf/` with `Accept: application/pdf` answers 406 (DRF content negotiation; the view only has the JSON renderer). `*/*` and the axios default work (verified 2026-10-28). The frontend must not send `Accept: application/pdf`, or the view needs a PDF-accepting renderer.
- **17.** Admin create/edit: two parallel requests with the same new slug (or create with the same email) both pass the uniqueness check; the second hits the database unique constraint -> 500 instead of 400. Very rare (admin only).
- **20.** Since the LOGGING change, the two R2-outage tests (logo upload, item image) print one expected "ERROR django.request: Bad Gateway" line each. An `assertLogs('django.request', level='ERROR')` in those tests would silence and check it (test change = its own turn).
- **21.** (2026-10-29) The backend enables CORS (`CORS_ALLOW_ALL_ORIGINS = DEBUG`, `CORS_ALLOWED_ORIGINS`), but with the BFF the browser never calls Django directly; CORS may be unnecessary. Revisit at step 12.
- **22.** (2026-10-29) PR #1 (`docs/readme-backend-status`, 2026-10-12) is still open; README still labels backend/ and frontend/ "(Upcoming)".
- **23.** (2026-10-29) npm marks eslint 9.39.5 deprecated (ESLint 9 out of support), but the plugins inside eslint-config-next 16.4.3 accept eslint <=9 only. Upgrade when eslint-config-next supports ESLint 10.
- **24.** (2026-10-29) npm 11 did not run the install scripts of unrs-resolver, @parcel/watcher and @swc/core (not in allowScripts). Lint and build work; approve them only if something breaks.
- **25.** (2026-10-29) `frontend/README.md` is the generator's boilerplate (yarn/pnpm/bun, Vercel deploy), which does not fit the Docker/VPS deployment.
- **26.** (2026-10-29) Doc mismatch: UC-GUEST-001 A2 says "This cafe's menu is temporarily unavailable."; UC-GUEST-002 (which A2 points to) says "This menu is temporarily unavailable. Please ask staff for assistance." The frontend uses the UC-GUEST-002 text. Doc change = its own turn.
- **28.** (2026-10-29) `.claude/launch.json` (preview server configs) is untracked; decide to commit it or ignore `.claude/`.
- **29.** (2026-10-29) The dev database holds demo data from seed_demo.py (plans basic/pro, 3 demo cafes, owners `*@demo.test` with unusable passwords); cafes/0002 and menu/0002 are still unapplied. Since 2026-10-30, demo-cafe@demo.test has a random test password (kept in a local scratch file, never in the repository).
- **30.** (2026-10-30) `/` still shows the generator's "Hello world!" page (`frontend/src/app/(customer)/page.tsx`). The docs do not say what the bare domain shows (a redirect to /login, or a short landing text).
- **31.** (2026-10-30) The user's path decision (/login, /dashboard, /admin, /bff/auth/*) is not in docs/ yet; system_design.md section 5 still says only "the BFF login route". Doc change = its own turn.
- **32.** (2026-10-30) The `...(forwardedFor ? { "X-Forwarded-For": forwardedFor } : {})` header spread is repeated in refresh.ts and the three BFF auth routes (login, logout, change-password); the 4xx pass-through block is repeated in login and change-password. Small helpers (for example in django.ts) would remove the copies; refactor = its own turn.
- **33.** (2026-10-31) `backend/.env.example` still says an empty FRONTEND_REVALIDATE_URL means "disabled (no frontend yet)"; the frontend endpoint exists since step 9.1 (aa58f17). Wording fix = its own small turn.
- **34.** (2026-10-31) Local development: `backend/.env` has FRONTEND_REVALIDATE_URL empty and `frontend/.env.local` has no FRONTEND_REVALIDATE_SECRET, so owner changes reach a local frontend only after the 5-minute fallback. For step 10 work, set both (URL `http://127.0.0.1:3000/internal/revalidate`, one shared random secret).
- **35.** (2026-10-31) `/menu/<unknown slug>` answers HTTP 200, not 404: the page streams (Cache Components), so the status is sent before `notFound()` runs and the "Menu not found" screen is drawn from the stream. UC-GUEST-001 A1 names 404 for the API; the docs do not say which status the frontend page must have. Decide only if it matters (noindex pages).
- **36.** (2026-10-31) The offline note shows only while `navigator.onLine` is false (the design the user approved in step 9 Q1). On Wi-Fi without internet, `onLine` stays true, so the service worker may serve the saved copy without the note. Fix if wanted: the worker marks the responses it serves from its cache, and the page shows the note for them.
- **37.** (2026-10-31) `public/sw.js` keeps `/_next/static` files of older deploys in `menu-files-v1` until VERSION changes; the cache of a returning customer grows a little with each deploy. Fix if it matters: prune files the current page did not load.
- **38.** (2026-11-01) `frontend/src/i18n/request.ts` always takes the language from the `lang` cookie and ignores a locale that code asks for, so `getTranslations({ locale: "en" })` still answers in the cookie's language (found with a temporary check page in step 10.2). The dashboards only use the cookie language today; code that needs a fixed language would get the wrong one. Fix: use the locale next-intl passes to `getRequestConfig` when one is given.
- **39.** (2026-11-01) `/bff/auth/session-ended` opens `/login` without saying why the session ended (Django rejected the token, or GET settings answered 403 because the account is no longer a Cafe Owner; step 10.3). An account with role CAFE_OWNER but no cafe, possible only through the Django admin site (`delete_cafe` also deletes the owner), is sent back to /login after every login with no message. Fix if wanted: session-ended adds a reason to the /login address, and the login page shows a short text for it.
- **40.** (2026-11-01) No test checks that a dashboard page behind `proxy.ts` gets the fresh access token after a refresh (the page half of the proxy's promise; the BFF route half is tested). In step 10.3b, removing the request Cookie rewrite in `proxy.ts` failed only the two BFF route tests: the page fell back to its error screen with status 200. Cover it in the dashboard session tests (step 10.11), for example by asserting that the page read its settings with the new token.

## Fixed

- **1.** `.env.example` was missing variables. Fixed 2026-10-28 (PR #10).
- **2.** `backend/requirements.txt` allowed `gunicorn>=21.2,<22.0` and `Pillow>=11.3`; system_design.md section 7 asks for `gunicorn>=23` and `Pillow>=12.3`. Fixed 2026-10-27 on branch feat/r2-uploads (user approved; Pillow 12.3.0, gunicorn 23.0.0, reportlab 4.5.1).
- **4.** No `LOGGING` setting. Fixed 2026-10-28 (PR #10).
- **5.** Max length for bilingual texts. Fixed 2026-10-28 (PR #11: the user chose name 100, description 500 per language).
- **10.** Hidden admin path DJANGO_ADMIN_PATH. Fixed 2026-10-28 (PR #10).
- **11.** Database CheckConstraints. Fixed 2026-10-28 (PR #10; the dev database still needs `migrate`).
- **12.** JSON 404 for unmatched URLs. Fixed 2026-10-28 (PR #10, handler404).
- **18.** End date on re-activation. Fixed 2026-10-28 (PR #11: the user chose to clear it to null).
- **19.** Billing notes. Fixed 2026-10-28 (PR #11: automatic "Plan changed from Basic to Pro." plus optional {"notes"} on activate/deactivate, max 500).
- **27.** No favicon (browsers requested /favicon.ico and got 404). Fixed 2026-10-31 (2ff3ef4, step 9.4): generated icons are linked from every page.
