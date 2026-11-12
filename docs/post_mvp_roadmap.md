# Post-MVP Roadmap

> Status: PROPOSAL (2026-11-09). Not a source of truth. Each phase starts with its own docs turns
> (use_cases.md, system_design.md, implementation_plan.md); only then is code written, one step per turn
> (AGENTS.md §3, build order §4). Out of scope still: ordering, table sessions, CAFE_STAFF, Redis.

## User decisions (2026-11-09)

| Topic | Decision |
|---|---|
| Analytics: what is counted | Menu opens per day and hour, and per table. No cookies, no personal data. |
| Analytics: who sees it | Basic: summary (opens per day). Pro: full detail (per table, per hour). |
| Password recovery | Both: first a one-time link made by the Super Admin (sent by WhatsApp), later self-service email. |
| Subscription end | Automatic deactivation by a nightly job, plus a warning 7 days before (owner + admin). |

## Facts found in the code that shape the plan

- The QR code encodes `{PUBLIC_MENU_BASE_URL}/menu/{slug}?table=N` (`backend/cafes/qr.py` `table_url`); a slug
  change breaks printed codes. `CafeTable.qr_token` (UUID, never regenerated) exists but is not in any URL.
- The public menu page is cached in Next.js (`"use cache"`, `cacheTag`, 300 s) — Django never sees a menu open,
  so analytics needs a browser beacon. `public/sw.js` ignores non-GET, so a POST beacon is safe.
- `subscription_end_at` is only written on a manual deactivation; nothing expires a cafe automatically.
- No email settings, no password reset, no health URL, no error tracking; only the `db` service has a
  Docker healthcheck. The backend image has no `curl` (healthchecks must use Python `urllib`), and
  `ALLOWED_HOSTS` is `DOMAIN,backend` (probes must call `http://backend:8000`).
- `create_plans` leaves existing plans unchanged (`get_or_create`), and there is no `cafes/admin.py`:
  a new plan flag needs a `--sync-flags` option (or a data migration).
- Item thumbnails (192 px) already exist (PR #66); the 1200 px image is never shown to customers.

## Phase 0 — Governance (no code) — done 2026-11-09

1. **AGENTS.md** (on the user's explicit request): §5 — remove "analytics" from the out-of-scope list;
   §4 — add an `analytics` app. Done in PR #69.
2. **Questions to the user**, answered 2026-11-09: (a) business time zone `Asia/Damascus`
   (`BUSINESS_TIME_ZONE`; `TIME_ZONE` stays UTC); (b) new dependencies approved (D: `sentry-sdk`,
   `@sentry/nextjs`; I: psycopg 3), each still added in its own step; (c) the exception to "never hand-write a
   migration" for RLS `RunSQL` (K only): approved 2026-11-12, for K only; (d) the SMTP provider (E2): Resend
   (2026-11-12).
3. **implementation_plan.md:** decisions table (Analytics, Business time zone, Monitoring, Password recovery,
   Subscription expiry, Approved dependencies), a link to this file, MVP steps 1–15 checked, and build-order
   steps 17–27 in the phase order below; RLS (step 16) is done last. The "QR Code URL" row changes with item A.

## Phase 1 — Before the first real cafe

### C. Health endpoint and uptime monitoring — size S — done 2026-11-09 (PR #71)
- Built as below; deploy/README.md §13 sets up the external monitor. The optional `CRON_HEARTBEAT_URL` was
  not built (it needs a monitor account first).
- **Docs:** system_design §3.7 "Health"; §5 Nginx rule `= /health`, healthcheck column in Docker Services.
- **Backend:** `HealthView` in `core/views.py` (no auth, `SELECT 1`) → 200 `{"status":"ok"}` or
  503 `{"detail":"Database unavailable."}` + `X-Error-Code: db_unavailable`; route `api/v1/health/`.
- **Frontend:** `src/app/health/route.ts` → `djangoFetch('/health/')`, 2 s timeout, no cache; not in the proxy matcher.
- **Infra:** Nginx `location = /health { access_log off; proxy_pass $frontend; }`; compose healthchecks
  (backend via `python -c urllib…http://backend:8000/api/v1/health/`, frontend via `node -e fetch…`),
  nginx `depends_on: condition: service_healthy`; deploy job polls `https://$DOMAIN/health` for 60 s;
  `deploy/README.md`: external monitor (UptimeRobot/Better Stack free) on `/health` + a keyword check on a demo menu;
  optional `CRON_HEARTBEAT_URL` pinged by each nightly job.
- **Tests:** `core/tests.py` — 200 healthy; 503 + header with a patched cursor.

### A. Stable QR links `/t/<qr_token>` — size M — done 2026-11-10 (PR #72)
- **Built differently from the design below:** the redirect is a Next.js route `/t/[token]` that asks a new public
  Django endpoint `GET /api/v1/qr/{token}/` (`{slug, table_number}`), instead of a Django redirect behind Nginx
  `error_page`. Reasons: it also works in local development (the QR points to the Next.js port), the browser
  keeps talking only to Next.js, and an unknown code redirects to the static `/qr-invalid` page without Nginx tricks.
  A Django outage answers 503 (`Retry-After: 60`) instead of "not valid".
- **Design:** Django answers `GET /t/<token>` with **302** (`Cache-Control: no-store`) to `/menu/<slug>?table=N`.
  It counts nothing (the analytics beacon is the only counter, so a scan is never counted twice).
  Inactive table → redirect without `table`; inactive cafe → redirect (page shows UC-GUEST-002);
  unknown/malformed token → 404, shown by Nginx `error_page` as a bilingual Next.js page `/qr-invalid`.
- **Docs:** use_cases GC 4 (QR encodes `/t/<qr_token>`); new **UC-GUEST-003 "Open Menu from QR"** (A1–A3);
  UC-OWNER-007/008/011 (`url`), UC-ADMIN-006 (printed codes survive a slug change);
  system_design §3.3 sample, §3.6 paths, §5 Nginx.
- **Backend:** `cafes/qr.py` `short_url(table)`; service `resolve_qr_token(token)`; `_qr_codes` and
  `qr_codes_pdf` print the short URL; `QrRedirectView` (UUID-validated) at `t/<str:token>` in `core/urls.py`.
- **Frontend:** `(customer)/qr-invalid/page.tsx`.
- **Nginx:** `location /t/` with the `menu` zone, X-Robots-Tag, HSTS, `proxy_intercept_errors on`, → `$backend`.
- **Tests:** redirect with table; after a slug change; inactive table/cafe; bad token 404; generate/preview/PDF
  contain `/t/`; e2e decodes the printed QR with `jsqr` and lands on the menu.
- **Risks:** `qr_token` becomes public (never treat it as a secret); the longer URL may raise the QR version
  (still fine at 8 cm, level Q).

### D. Error tracking — size S–M — done 2026-11-10 (PR #73)
- Built as below with `sentry-sdk>=2.73` and `@sentry/nextjs` 11.11.0 (11.9.0, two weeks older, pulled in
  vulnerable `glob`/`minimatch`). SDK 11 replaced `sendDefaultPii` with `dataCollection`, whose defaults collect
  everything: user info, cookies, headers, bodies and stack-frame variables are switched off explicitly; the
  Python SDK also gets `include_local_variables=False` and `max_request_body_size='never'`.
- Hosted Sentry or hosted GlitchTip (same SDK; no self-hosting on the small VPS). Errors only
  (`traces_sample_rate=0`), `send_default_pii=False`, `before_send` strips cookies/Authorization, `release=IMAGE_TAG`.
- Turns: add `sentry-sdk`; settings active only when `SENTRY_DSN` is set (+ `.env.example`, compose);
  add `@sentry/nextjs` server-side only (`instrumentation.ts`, `onRequestError`), nothing on the customer menu.
- **Docs:** system_design §5 and a §7 row.
- **Fallback if declined:** after E2 adds SMTP, Django `ADMINS` + `mail_admins` emails every 500.

## Phase 2 — Operations

### E1. One-time password reset link made by the Super Admin — size M — done 2026-11-10 (PR #74)
- Built as below. Details decided while building: the link is made in `users/services.py`
  (`password_reset_link(user)`; `cafes/services.py` only finds the owner); the throttle rate is fixed (5/min, no
  environment variable); an inactive account gets the "invalid link" answer; the new password may equal the old one;
  a second link does not end the first (the first one used ends all). The reset page gets
  `Referrer-Policy: no-referrer` from `next.config.ts`. No e2e test (the unit and integration tests cover it).
- **Design:** Django `default_token_generator` (no new table; the token contains the password hash, so it dies
  when the password changes). Link `{base}/reset-password#<uidb64>.<token>` — the `#` part never reaches a server
  or a log. `PASSWORD_RESET_TIMEOUT = 86400` (24 h, WhatsApp can be slow).
- **Docs:** new **UC-ADMIN-010 "Generate Password Reset Link"**, **UC-AUTH-005 "Reset Password with Link"**
  (A1 invalid/expired, A2 password rules, A3 throttled); system_design §3.1, §3.2, §3.6, §7.
- **Backend:** new `users/services.py` with `revoke_sessions(user)` (moved out of `ChangePasswordView` — its second
  real use) and `reset_password(uidb64, token, new_password)`; `cafes/services.py` `password_reset_link(cafe_id)`.
  `POST /api/v1/admin/cafes/{id}/password-reset-link/` (IsSystemAdmin) → 200 `{url, expires_at}`;
  `POST /api/v1/auth/password-reset/confirm/` (AllowAny, throttle scope `password_reset` 5/min) → 204;
  400 `reset_link_invalid` / `new_password` errors; 404 unknown cafe; 429.
- **Frontend:** `admin/cafes/[id]/reset-link-dialog.tsx` (Copy button); `(app)/reset-password/page.tsx` (reads and
  clears `location.hash`, `no-referrer`, not in the proxy matcher); BFF `bff/auth/password-reset/route.ts`;
  `reset_link_invalid` in `api-errors.ts` CODES.
- **Nginx:** BFF route and confirm API in the `login` zone.
- **Tests:** link used twice → 400; after change-password → 400; expired → 400; all refresh tokens blacklisted
  after a reset; non-admin 403; unknown cafe 404; throttle.

### F. Automatic subscription expiry and warnings — size M–L — done 2026-11-10 (PR #75)
- Built as below. Details decided while building: `days_left` is a model property (`Cafe.days_left`, with
  `core/business_time.py` `business_today()`); a manual deactivation keeps `subscription_expires_on`; the
  `expired` event's notes are "Paid until YYYY-MM-DD."; `renew_inactive` text is "Cafe is inactive. Activate it
  instead."; the 2-year limit is 731 days; the date fields propose one month ahead; the admin badges also show in
  the cafe list. The dev database needs `migrate` (cafes 0003). No heartbeat (item C's optional part is not built).
- **Design:** new field `cafes.subscription_expires_on DATE NULL` ("paid until this day, inclusive, Damascus time").
  `subscription_end_at` keeps its meaning (the moment of deactivation). New `BillingEvent.Action` values
  `renewed`, `expired`; system actions use `performed_by=None` and show as "System".
- **Docs:** use_cases GC 5 (expiry rule); UC-ADMIN-004 (`expires_on` required at activation, ≤ 2 years);
  new **UC-ADMIN-011 "Renew Subscription"**, **UC-ADMIN-012 "Automatic Expiry"** (actor: System);
  UC-ADMIN-002/003/008/009 and UC-OWNER-014 (new fields); system_design §2.2, §3.2, §5 Scheduled Jobs.
- **Backend:** model field + actions; `_set_subscription(..., action=)`; activation takes `expires_on`;
  `renew_cafe(cafe_id, *, expires_on, notes, performed_by)` (400 `renew_inactive`, date must be later);
  `expire_due_subscriptions(today)` (idempotent, tolerates an admin race); `days_left`; serializers
  (owner settings, admin list/detail, stats `expiring_soon_cafes`); `POST cafes/{id}/renew/`;
  command `expire_subscriptions` (template: `core/management/commands/backup_database.py`).
- **Frontend:** dashboard banner when ≤ 7 days left (next to `InactiveNotice`); admin date field in the
  subscription dialog, renew dialog, "expires in N days"/"overdue" badges; billing history shows "System".
- **Infra:** `backend/crontab` `10 21 * * * python manage.py expire_subscriptions` (00:10 Damascus).
- **Tests:** activation needs the date; renew; the job deactivates only due active cafes, writes `expired`
  with `performed_by=None`, revalidates the menu (mocked); a cafe expiring today stays active.
- **Risks:** cron down → cafes stay active (C's heartbeat detects it); NULL date never expires
  (admin list shows "no end date").

## Phase 3 — B. Analytics — size L — done 2026-11-10 (PR #76)

- **Built differently from the design below:** the browser does not call Django directly. The menu page posts to
  a Next.js route, `POST /menu/<slug>/views`, which passes the body to Django's public
  `POST /api/v1/menu/<slug>/views/`. Reasons (the same as for item A): it works in local development, where
  Next.js and Django are on different ports; the browser keeps talking only to Next.js, so the BFF rule of
  system_design §3.6 needs no exception; and the route passes on nothing about the visitor. Nginx has the zone
  `views` on both paths.
- Other details decided while building: a missing body counts as "no table"; `?days=` without a value is the
  default week; `create_plans --sync-flags` sets all feature flags to their standard values (limits untouched) and
  must be run once on an existing database; `prune_menu_views` runs at 03:00 UTC; the owner's home page names the
  plan's analytics level; the page skips the report while the browser is offline.

- **Beacon:** `POST /api/v1/menu/{slug}/views/` body `{"table": N|null}` → 204. The browser calls Django
  directly (public, no token; write this exception to the BFF rule into system_design §3.4).
  Sent once per page load from `menu-view.tsx` (module-level guard against StrictMode double effects),
  `navigator.sendBeacon` with a JSON Blob, fallback `fetch(..., {keepalive: true})`. No cookies or storage:
  the metric is "menu opens" (a reload counts again). Unknown slug 404; inactive cafe 204 not counted;
  a table that is not an active table of the cafe → bucket 0.
- **Storage:** new app `analytics`, table `menu_view_counts`: `cafe` FK (CASCADE), `hour` TIMESTAMPTZ (start of the
  UTC hour), `table_number` SMALLINT 0..200 (0 = no table; CHECK), `count`; `UNIQUE(cafe, hour, table_number)`.
  Increment with `update(count=F('count')+1)`, else `create` in a savepoint, retry the update on IntegrityError.
- **Plan flag:** `allows_detailed_analytics` (default False); `create_plans --sync-flags` sets it on Pro;
  `PlanSerializer` sends it to the owner UI.
- **Reading:** `TruncDate` / `ExtractHour` in the business time zone; missing days filled with 0;
  `summary(cafe, days)` for all plans, `detail(cafe, days)` checks the flag → 403
  `{"detail":"Detailed analytics require a Pro plan."}`, code `analytics_need_pro`. `days` ∈ {7, 30, 90}.
- **Retention:** nightly `prune_menu_views` deletes rows older than 400 days.
- **Docs:** new **UC-GUEST-004 "Record Menu Open"**, **UC-OWNER-015 "Analytics Summary"**,
  **UC-OWNER-016 "Detailed Analytics"**; use_cases GC 3 (new flag); system_design §1, §2.2, §3.3, §3.4, §5, §6,
  §7 privacy row (no IP, user agent or cookies stored); implementation_plan "Analytics" row.
- **Backend (build order):** model + migration → services (`record_view`, `summary`, `detail`) → serializers
  (beacon `table` 1..200 or null; query `days`) → permissions (existing `IsCafeOwner, IsActiveCafe`) → views →
  URLs (`api/v1/dashboard/analytics/summary/`, `.../detail/`, public beacon route) → tests.
- **Frontend:** `menu/[slug]/page.tsx` passes `slug` to `MenuView`; `dashboard/analytics/page.tsx` with
  `bar-chart.tsx` (plain SVG, `dir="ltr"`, screen-reader table; no chart library); new entry in
  `dashboard-nav.tsx` `SCREENS`; readers in `owner-api.ts`; Basic shows a Pro note and does not call `detail`;
  `analytics_need_pro` in CODES; messages in `en.json` / `ar.json`.
- **Nginx:** new zone `views` (1 r/s per IP) and `location ~ ^/api/v1/menu/[^/]+/views/$` (burst 50).
- **Tests:** opens counted; same hour increments one row; bad table → 0; inactive cafe not counted; tenant
  isolation; Basic on `detail` → 403 + header; `days` validation; zero-filled days.
- **Risks:** scripts can inflate numbers (label as "approximate"); one DB write per open (fine at this size).

## Phase 4 — Menu features

### G. Item tags — size M — done 2026-11-11 (PR #77)
- Built as below. Details decided while building: a repeated code is stored once and the list is kept in the
  fixed order (the service does it); in a PATCH `tags` replaces the whole list; the filters combine with AND; a
  filter button appears only for a dietary tag that an item of the menu has; the choice is not stored;
  `django.contrib.postgres` is now in `INSTALLED_APPS` (Django 6 needs it for `ArrayField`); no database CHECK on
  the codes. The tag texts are the "Tags" messages. Choosing a filter has no automated test (observation 61).
- **Design:** fixed set (`TextChoices`: vegan, vegetarian, gluten_free, spicy, contains_nuts, contains_dairy),
  translated in the message files; `MenuItem.tags` PostgreSQL `ArrayField`, default `[]`, max 6, de-duplicated;
  all plans. Dietary tags filter, allergen tags show as warnings.
- **Docs:** new GC 11 "Item tags"; UC-OWNER-002/013; UC-GUEST-001 (filter flow, empty state); system_design §2.2, §3.4.
- **Backend:** `tags=` keyword in `create_item` / `update_item`; owner and public serializers return `tags`.
- **Frontend:** `lib/tags.ts`; checkboxes in `item-fields.tsx`; `ItemValues` / `valuesFrom` in `items/actions.ts`;
  badges in `item-row.tsx` and `menu-view.tsx`; filter chips in the browser (the cached page stays shared).

### H. Item variants (sizes with prices) — size L — done 2026-11-11 (PR #78)
- **Built with the default, not confirmed by the user:** no plan flag (every plan has variants) and variants do
  not count toward `max_items`. The user was not available to confirm; changing it later needs a plan flag and
  a check in `menu/services.py`, no data change.
- **Decided while building:** the 400 errors of a variant are keyed by its position, like tags
  (`{"variants": {"1": {"price": [...]}}}`); `variants: []` in a PATCH keeps the item's last price unless `price`
  is sent too; a variant `id` is not stable (replace-all); the price rule (A8) is the service's, so a create
  without `price` and without `category_id` now reports `category_id` first.
- **Design:** table `menu_item_variants`: `item` FK (CASCADE), `cafe` FK (copied, checked in `save()` like
  `MenuItem`), bilingual `name` (max 50), `price` NUMERIC(10,2) CHECK ≥ 0, gapped `sort_order`. Written as a
  nested `variants` list on item create/PATCH, replace-all in one transaction under the cafe lock (GC 8), max 10.
  With variants, `item.price` = lowest variant price ("from X"); sending `price` too → 400.
  Variants do not count toward `max_items`; no plan flag (confirm with the user).
- **Docs:** GC 10 (variant prices, "from X"); UC-OWNER-002/013; UC-GUEST-001; system_design §2.2, §2.3, §3.3,
  §3.4, §7.1 table list; the public menu becomes 4 queries.
- **Frontend:** variant rows with add/remove/up/down buttons in `item-fields.tsx`; `actions.ts` parses
  `variants.N.*`; "from X" in `item-row.tsx`; sizes listed in `menu-view.tsx`.
- **Tests:** nested error paths (`variants.0.price`); replace-all; cross-tenant; ordering; `assertNumQueries(4)`.

## Phase 5 — Hardening

### E2. Password reset by email — size M — done 2026-11-12 (PR #80)
- As built: the email is sent in a background thread (the answer time must not tell whether an account
  exists); only Cafe Owner accounts get one; 5/hour per IP and one email per account per 5 minutes; without
  `EMAIL_HOST` the endpoint answers 503 and only the Super Admin link (E1) works; the page is
  `/forgot-password`, its BFF route `/bff/auth/forgot-password`.
- **Docs:** new **UC-AUTH-006 "Request Password Reset Email"** (always 204, no user enumeration).
- **Backend:** `EMAIL_*`, `DEFAULT_FROM_EMAIL`, `EMAIL_TIMEOUT=10` (+ `.env.example`, compose; console backend in
  development); `request_password_reset(email)` sends one bilingual `EmailMessage` reusing E1's token and page;
  IP throttle + per-email cooldown in `DatabaseCache`; `POST /api/v1/auth/password-reset/`. No new dependency.
- **Frontend:** "Forgot password?" link on `/login`, a request page, a BFF route in the `login` zone.
- **deploy/README:** SPF, DKIM, DMARC. **Risk:** owner emails created by the admin may not be real addresses.

### I. psycopg 3 and persistent connections — size S (new dependency) — done 2026-11-12 (branch `chore/psycopg3`)
- The age comes from `DB_CONN_MAX_AGE` (empty = 60).
- `psycopg[binary]>=3.2,<4` instead of `psycopg2-binary`; `CONN_MAX_AGE=60` (from the environment),
  `CONN_HEALTH_CHECKS=True`; no pool (not combinable with `CONN_MAX_AGE`; little gain with sync Gunicorn).
  Do this before K.

### J. Images — size S (recommend skipping for now)
- Thumbnails exist. Left: the 1200 px image is never shown (only useful with an item detail sheet); an optional
  `logo_thumbnail_url` (512 px logo shown at 48 px). Nothing deployed, so no backfill.

### K. PostgreSQL RLS (implementation_plan step 16) — size L
- Designed 2026-11-12 in system_design.md §7.1, which now wins over the notes below. Changes against them:
  the owner role is the role the `db` service already creates (no new `tartus_owner`), because `pg_dump` needs
  a role that policies do not apply to; the app role is made by a command, `create_app_role`; the policy uses
  `NULLIF(current_setting('app.cafe_id', true), '')`; read services return evaluated data; no composite FK.
- Build order: (1) `core/tenancy.py` and its use in every service, behavior unchanged; (2) the test setup and
  the CI role; (3) the `RunSQL` migrations, `billing_events` first; (4) `create_app_role`, Compose, `.env.example`,
  deploy/README; (5) the RLS tests.
1. Docs: turn system_design §7.1 into a concrete design; add `menu_view_counts` and `menu_item_variants`.
2. Two DB roles: `tartus_owner` (owns tables, runs `migrate`) and `tartus_app` (NOBYPASSRLS);
   env `DB_MIGRATE_USER` / `DB_MIGRATE_PASSWORD`.
3. `core/tenancy.py`: `set_config('app.cafe_id', …, true)` at the start of each service transaction
   (owner: `request.user.cafe`; public menu: cafe by slug; admin and cron: `app.rls_bypass`).
   No `ATOMIC_REQUESTS` (it would wrap R2 uploads in DB transactions).
4. `RunSQL` migration (needs the Phase 0 exception): ENABLE + FORCE RLS, policy
   `cafe_id = current_setting('app.cafe_id', true)::bigint OR current_setting('app.rls_bypass', true) = 'on'`;
   start with `billing_events`, then the other tables. Optional composite FK (§7.1).
- **Tests:** CI runs as `tartus_app`; an unfiltered query in an owner context returns only that cafe; no tenant → 0 rows.

## Order and sizes

| Phase | Items | Sizes |
|---|---|---|
| 0 | Governance, decisions, implementation_plan | — |
| 1 | C health, A stable QR, D error tracking | S, M, S–M |
| 2 | E1 reset link, F subscription expiry | M, M–L |
| 3 | B analytics | L |
| 4 | G tags, H variants | M, L |
| 5 | E2 email reset, I psycopg 3, J images, K RLS | M, S, S, L |

## Checks for every step

`python manage.py test <app>`, `python manage.py makemigrations --check --dry-run`, `npm run lint`,
`npx tsc --noEmit`, `npm test`, and `npm run e2e` when the frontend changes; CI green before each merge.
