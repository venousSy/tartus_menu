# Best Practices, Suggestions and Skills -- Research Notes

> **Status: ADVISORY. This file is NOT a source of truth.**
> The source-of-truth documents are listed in `AGENTS.md` Section 2 (`use_cases.md`, `system_design.md`, `implementation_plan.md`, and the diagrams).
> If anything here conflicts with them, they win. Nothing in this file is a decision until the user moves it into those documents.
>
> Written: 2026-10-12. Based on: the current code on branch `feat/backend-auth-layer`, the docs in `docs/`, and research into similar products and reference code (see Section 11).

---

## 0. How to Read This File

Every suggestion has two tags.

**When** -- the phase where it matters:

| Tag | Meaning |
|---|---|
| `NOW` | Affects backend code being written in the current build phase. |
| `FRONTEND` | Matters when the Next.js app is built. |
| `LAUNCH` | Must be done before real cafes use the system. |
| `LATER` | A good idea after the MVP. Do not build it now. |

**Kind** -- how much approval it needs:

| Tag | Meaning |
|---|---|
| `FITS-DOCS` | Already allowed by the docs. It is only a "how", not a "what". |
| `DECISION` | Would add to or change a locked decision. The user must decide first and update the docs. |
| `NEW-DEP` | Needs a new package in `requirements.txt` or `package.json`. Ask before adding (AGENTS.md Section 3). |

---

## 1. What Was Compared

| System | Type | What we can learn from it |
|---|---|---|
| FeastQR (github.com/jakubczarnowski/FeastQR) | Open-source menu SaaS. Next.js + Supabase + Prisma + Postgres. | Same product shape as ours: menus, QR codes, printable PDF templates, i18n. Uses typed end-to-end API calls (tRPC). |
| workouse/qr-menu | Open-source, multi-tenant (organizations -> venues -> menus), role-based access. | Clear tenant hierarchy and roles. **License is CC BY-NC 4.0: we must not copy its code into a commercial product.** Learn from ideas only. |
| MENU TIGER, Menubly, FineDine, UpMenu | Commercial QR-menu products. | Paid tiers are separated by branding, photos and languages -- the same split as our Basic/Pro flags. Bigger tiers add ordering, POS, analytics. |
| HackSoft Django Styleguide | Reference architecture for Django service layers. | Rules for services, thin APIs, error handling and testing. Very close to our `AGENTS.md` layering. |
| django-rls-tenants and similar libraries | Reference code for PostgreSQL Row-Level Security in Django. | How professionals implement the "RLS" part of our multi-tenancy decision. |
| OWASP API Security Top 10 (2023) | Security standard for APIs. | Our biggest risk (one cafe seeing another cafe's data) is risk number 1 on this list. |

**Main lesson.** Our MVP matches the "menu-only" tier of commercial products. At this tier, professional products do not win by having more features. They win by being **fast on a phone, always correct, safely isolated between cafes, and easy for the owner to update**. Most suggestions below serve those four goals.

---

## 2. What This Project Already Does Well

These match professional practice. Keep them.

1. **Service layer** for business rules (`services.py`), thin views. Same idea as the HackSoft styleguide.
2. **Tenant taken from `request.user.cafe`**, never from the request body or URL. This is the main defense against cross-tenant attacks.
3. **404 instead of 403 for another cafe's object** ("ownership masking"). An attacker cannot learn which IDs exist.
4. **Plan rules use flags and limits, not plan names.** Adding a third plan later needs no code change.
5. **Gapped sort order** (100, 200, 300). Moving one item rarely needs to rewrite every row.
6. **Soft delete with a default manager** (`ActiveManager`) that hides deleted rows.
7. **Short access token (15 min) + refresh rotation + blacklist.** This is the recommended JWT setup.
8. **Change password is atomic** and blacklists all refresh tokens in one query.
9. **Denormalized `cafe_id` on `menu_items`** with a `save()` check that it matches the category's cafe.
10. **Settings fail fast in production** when `DJANGO_SECRET_KEY` or `DJANGO_ALLOWED_HOSTS` is missing.
11. **Persisted `CafeTable` rows with a stable `qr_token`.** This keeps a path open to "dynamic QR codes" later (Section 4.1).
12. **Inactive cafe returns 200 with `is_active: false`.** This lets the cached page show a friendly screen instead of an error page.

---

## 3. Backend (Django + DRF)

### 3.1 Service layer conventions (from the HackSoft styleguide) -- `NOW`, `FITS-DOCS`

- **Keyword-only arguments.** Write `def create_category(*, cafe, name, is_visible=True)`. The `*` forces callers to name each argument. This prevents mixing up two arguments of the same type.
- **Type hints** on every service function. They document the inputs and help your editor catch mistakes.
- **One transaction per business operation.** Wrap multi-step writes in `transaction.atomic()`. The docs already require this for create cafe, activate, deactivate, delete cafe and sync tables.
- **Names.** The docs already use class names such as `CafeService.create_cafe()` and `TableService.sync_tables()`. HackSoft allows classes used as namespaces. Keep the names from the docs.
- **Selectors (optional).** HackSoft puts complex reads in a separate `selectors.py`. `AGENTS.md` does not list this layer, so do not add it now. If the public-menu read becomes complex, it is the first candidate. That would be a `DECISION`.

### 3.2 How services report errors -- `NOW`, `FITS-DOCS`

The docs require DRF's error format `{"detail": "..."}` with exact messages and status codes.

**Recommended (simplest):** raise DRF's built-in exceptions directly from services:

```python
from rest_framework.exceptions import PermissionDenied, ValidationError

if plan.max_categories is not None and active_count >= plan.max_categories:
    raise PermissionDenied(
        f"Your Basic plan allows a maximum of {plan.max_categories} categories. "
        "Upgrade to Pro for unlimited."
    )
```

DRF turns this into `403 {"detail": "..."}` automatically. No custom code is needed.

- **Trade-off:** the service now imports from DRF, so it is tied to the web layer. HackSoft prefers custom domain exceptions plus a custom exception handler. That is cleaner but adds a file and a mapping. For a project of this size, DRF's built-in exceptions are the better choice. `AGENTS.md` also says "prefer Django and DRF built-ins".
- **Careful with plan messages.** UC-OWNER-001 A1 says "Your Basic plan allows...". The rule "never compare plan names" is about logic, not text. Build the message from `plan.get_name_display()` and the limit value, so the text stays right if limits change.

### 3.3 Race conditions -- `NOW`, `FITS-DOCS` (important)

A **race condition** is a bug that only happens when two requests run at the same moment.

**Problem 1 -- plan limits.** The limit check is "count, then insert". A Basic cafe has 4 of 5 categories. The owner double-clicks "Save" (or has two tabs open). Both requests count 4. Both insert. The cafe now has 6 categories. The limit is broken.

**Problem 2 -- `sort_order = max + 100`.** Two creates at the same moment read the same max. Both get the same `sort_order`.

**Professional fix:** lock the cafe row at the start of the transaction. Other writers for the same cafe wait their turn.

```python
from django.db import transaction

with transaction.atomic():
    # Locks this one cafe row until the transaction ends.
    # A second request for the same cafe waits here.
    Cafe.objects.select_for_update().get(pk=cafe.pk)
    active_count = Category.objects.filter(cafe=cafe).count()
    # ... check limit, compute sort_order, create ...
```

- This needs PostgreSQL. It does nothing on SQLite. Run tests on PostgreSQL (Section 3.9).
- Use the same lock in: create category, create item, both reorder endpoints and `sync_tables`.
- Only one cafe is locked, so other cafes are not slowed down.

### 3.4 Database and model details

**Database constraints back up serializer validation** -- `NOW` or `LATER`, `FITS-DOCS`.
Validators on a model field only run in forms and `full_clean()`. A `CheckConstraint` runs inside PostgreSQL on every write, even from the shell or a bug. Good candidates:

| Rule | Source | Constraint idea |
|---|---|---|
| Price is not negative | UC-OWNER-002 A3 | `Q(price__gte=0)` |
| Table number 1..200 | UC-OWNER-007 | `Q(table_number__gte=1, table_number__lte=200)` |
| Color is `#RRGGBB` or empty | system_design 2.2 | regex check on `primary_color` |

Each constraint needs a model change plus a migration (two turns).

**Indexes** -- `LATER`.
Almost every query filters by `cafe_id` and `deleted_at IS NULL` and orders by `sort_order`. Django already indexes each foreign key. At MVP size (tens of categories, hundreds of items per cafe) extra indexes give no real gain. Measure first with `EXPLAIN ANALYZE`. If needed later, use a **partial index**: an index that only contains rows matching a condition, for example `Index(fields=["cafe", "sort_order"], condition=Q(deleted_at__isnull=True), name=...)`.

**Database-level tenant check for items** -- `LATER`, `DECISION`.
Today `MenuItem.save()` checks that `item.cafe == item.category.cafe`. `bulk_update()` and `QuerySet.update()` skip `save()`. PostgreSQL can enforce this with a **composite foreign key**: `UNIQUE (id, cafe_id)` on `categories`, then `FOREIGN KEY (category_id, cafe_id)` on `menu_items`. Django has no field for this, so it would need a `RunSQL` migration. Consider it together with RLS.

**Soft-delete manager side effects** -- `NOW`, `FITS-DOCS` (just know them).
- The Django admin uses the default manager, so soft-deleted rows are invisible in the admin. If the Super Admin ever needs to see or restore them, override `ModelAdmin.get_queryset()` to use `all_objects`.
- Accessing a parent through a foreign key (`item.category`) uses Django's base manager. It returns the category even if it was soft-deleted. Services must still check `deleted_at` when that matters.

**Bilingual JSON fields** -- `NOW`, `DECISION`.
JSONB `{"ar": "...", "en": "..."}` is a good choice for exactly two fixed languages. Professional alternatives (`django-modeltranslation`: one column per language; `django-parler`: a separate translation table) only pay off with many languages. Keep JSONB. But the docs do not say:
- which keys are required (is `ar` required and `en` optional?),
- whether extra keys are rejected,
- what the customer sees when the chosen language is empty.
The serializer must validate the JSON shape. See Open Question 3.

**Money after the 2026 redenomination** -- `FRONTEND`, `DECISION`.
On 2026-01-01 Syria removed two zeros from the pound (100 old SYP = 1 new SYP, same ISO code SYP). The API example in `system_design.md` (`"price": "5000"` for an espresso) uses old-pound scale. `NUMERIC(10,2)` still works. Decide the display rules: hide `.00`? Western digits (0-9) or Arabic-Indic digits? See Open Question 4.

### 3.5 Public menu endpoint (the hottest endpoint) -- `NOW`, `FITS-DOCS`

Every customer scan hits `GET /api/v1/menu/{slug}/` (unless the page is cached).

- **Avoid the "N+1 query" problem.** N+1 means: one query for the categories, then one more query per category for its items. With 15 categories that is 16 queries. Use `prefetch_related` with filtered `Prefetch` objects so the whole menu loads in about 3 queries (cafe, categories, items):

```python
from django.db.models import Prefetch

visible_items = MenuItem.objects.filter(is_available=True).order_by("sort_order", "id")
categories = (
    Category.objects.filter(cafe=cafe, is_visible=True)
    .prefetch_related(Prefetch("items", queryset=visible_items))
    .order_by("sort_order", "id")
)
```

  (`MenuItem.objects` already hides soft-deleted rows through `ActiveManager`.)
- **Lock the query count in a test** with `assertNumQueries(3)`. If someone later adds a field that triggers extra queries, the test fails.
- **Do not throttle this endpoint per client IP in DRF.** (Corrected 2026-10-12.) With ISR, the caller is the Next.js server, not the customer's browser, so every request would come from the same IP and a per-IP throttle would block all cafes at once. Rate-limit the `/menu/` pages in Nginx instead.

### 3.6 Authentication and login hardening

**Login rate limiting** -- `LAUNCH`, `FITS-DOCS`.
Without a limit, an attacker can try thousands of passwords. There are two layers:
1. **Nginx `limit_req`** on `/api/v1/auth/login/`. Built into Nginx. Works before Django even runs. Recommended.
2. **DRF `ScopedRateThrottle`** on the login view. DRF stores counters in Django's cache. The default cache (`LocMemCache`) lives inside one process. Gunicorn runs several worker processes, so each worker keeps its own counter and the real limit becomes "limit x number of workers". Redis is out of MVP scope. Use Django's built-in `DatabaseCache` instead (`python manage.py createcachetable`). It is shared by all workers and fast enough at our traffic.
- `django-axes` (account lockout after N failures) is a common extra. It is `NEW-DEP`, and the docs do not ask for it.

**Clean up old tokens** -- `LAUNCH`, `FITS-DOCS`.
The simplejwt blacklist app writes one `OutstandingToken` row for every refresh token it issues. With rotation, an active owner creates a new row about every 15 minutes. The table grows forever unless you run `python manage.py flushexpiredtokens` daily (cron or a scheduled container). The simplejwt docs recommend exactly this.

**Where the frontend keeps tokens** -- `FRONTEND`, `DECISION`.
- Do **not** store tokens in `localStorage`. Any injected script (XSS) can read it.
- Professional pattern: **BFF ("Backend For Frontend")**. Next.js server routes hold the refresh token in an `HttpOnly; Secure; SameSite=Strict` cookie. Browser JavaScript can never read it. Next.js forwards the access token to Django as `Authorization: Bearer ...`. Django needs no change.
- Our Nginx serves Next.js and `/api/` on the same domain, which makes cookies simple.

**Refresh rotation trap: "single-flight" refresh** -- `FRONTEND`, `FITS-DOCS` (important).
With `ROTATE_REFRESH_TOKENS` + `BLACKLIST_AFTER_ROTATION`, every refresh token works **once**. If two requests get a 401 at the same time and both call refresh with the same token, the first succeeds and the second gets 401 (token already blacklisted). The user is logged out for no visible reason. The fix: allow only one refresh call at a time. Other requests wait for it and reuse its result ("single-flight"). Do the same across browser tabs, or let the BFF do the refresh on the server.

**Django admin exposure** -- `LAUNCH`, resolved 2026-10-12.
The docs disagreed: `system_design.md` Section 5 routed only `/api/*` to Django, while `deployment_architecture.html` also routed `/admin/` to Django. A public `/admin/` path is easy to find and may clash with frontend routes. Decision: the Django admin is served at a non-obvious path from env `DJANGO_ADMIN_PATH`, routed by Nginx with login rate limiting (IP allowlists do not work well with changing mobile IP addresses). The admin also needs its static files (`collectstatic` + Nginx `/static/`).

**Admin-supplied `logo_url`** -- `NOW` (when building UC-ADMIN-006), `DECISION`.
UC-ADMIN-006 lets the Super Admin PATCH `logo_url`. If any URL is accepted, a typo or a stolen admin account can put a tracking image or an offensive image on a public menu. Professional systems only accept URLs on their own storage domain (our R2 custom domain). See Open Question 5.

### 3.7 Image uploads (UC-OWNER-006, UC-OWNER-010) -- when building uploads

**Check the file content, not the header** -- `FITS-DOCS`.
The `Content-Type` header comes from the client, so an attacker can fake it. Open the bytes with Pillow and restrict formats:

```python
from PIL import Image

Image.MAX_IMAGE_PIXELS = 25_000_000  # protects against "decompression bombs"

with Image.open(uploaded_file, formats=["JPEG", "PNG", "WEBP"]) as img:
    img.verify()  # structural check; the object is unusable afterwards
uploaded_file.seek(0)
# reopen, then img.load() to decode fully
```

A **decompression bomb** is a small file (for example 100 KB) that expands to gigabytes of pixels in memory and crashes the server.

**Re-encode the image** -- `DECISION` (changes the stored format).
Professional pipelines never store the original upload. They:
1. resize it (for example, longest side 1200 px),
2. remove all metadata -- **EXIF** is hidden photo data that can include the GPS location where the photo was taken,
3. save as WebP.

Benefits: smaller files for slow Syrian mobile networks, no leaked location data, and any hidden payload in the original file is dropped.

**Reject big uploads early** -- `LAUNCH`, `FITS-DOCS`.
Set Nginx `client_max_body_size` (for example `3m`) so a 500 MB upload is rejected before it reaches Django. The 2 MB rule from the docs is still checked in the service.

**Object names in R2** -- `FITS-DOCS`.
Use random names such as `cafes/<cafe_id>/items/<uuid4>.webp`. Never use the uploaded filename.
- A new upload gets a new URL, so CDN caches never show an old image.
- Because each URL never changes content, the object can be cached "forever": `Cache-Control: public, max-age=31536000, immutable` (set `AWS_S3_OBJECT_PARAMETERS` in settings).

**Delete the old image only after the database commit** -- `FITS-DOCS`.
UC-OWNER-006 says "delete the old image". If you delete it from R2 first and the database save then fails, the item points to a missing image. Use `transaction.on_commit(...)` to delete the old object after the commit succeeds. If that delete fails, log it. Do not fail the request. An orphan file costs almost nothing.

**R2 public URLs** -- `LAUNCH`, `FITS-DOCS` (important).
- Cloudflare says the `r2.dev` address is for testing only. It is rate-limited and not cached. Use a **custom domain** in production (`R2_CUSTOM_DOMAIN`).
- `django-storages` creates **signed URLs that expire after 1 hour** unless a custom domain is set (or `AWS_QUERYSTRING_AUTH = False`). If a signed URL were saved into `logo_url` or `image_url`, every image would break an hour later. Make `R2_CUSTOM_DOMAIN` required whenever `USE_S3=True`.

**Image resizing for different screens** -- `LATER`.
Next.js's built-in image optimizer uses CPU on our small VPS. Options: (a) resize once at upload time (above) and serve that file directly; (b) Cloudflare Image Transformations (free plan: 5,000 unique transformations per month, works with R2 behind a custom domain) through a custom `next/image` loader. Start with (a).

### 3.8 QR codes and the PDF (UC-OWNER-007, 008, 011) -- when building QR

Printed QR codes live on tables for years and get wet, scratched and photographed in dim light.

| Practice | Why |
|---|---|
| Error correction level **M or Q** (not L) | The code can still be read when part of it is dirty or damaged. Higher levels make the code denser, so do not jump to H without a reason. |
| **Quiet zone of 4 modules** (`border=4` in the `qrcode` library) | The empty margin is what lets the camera find the code. Card designs often break this rule. |
| Printed size **at least 2.5-3 cm** | Common minimum for reading at table distance (about 10:1 distance-to-size). |
| Dark code on a light background | Many phone cameras fail on inverted (light-on-dark) codes. |
| Table number and the short URL printed under the code | Staff can read it, and customers can type the URL if scanning fails. |
| **Vector QR in the PDF** | ReportLab has a built-in QR drawing widget (`reportlab.graphics.barcode.qr`). It draws the code as vector shapes, so it stays sharp at any print size. The docs only say "reportlab" for the PDF, so this fits. Make sure the PDF and the preview encode the exact same URL. |
| Short URL | Fewer characters make a simpler code that scans faster. A short domain helps. |
| Test the printed card on several phones, including an old Android phone | Vendor guides all repeat this. It is the only real proof. |

### 3.9 Testing -- `NOW` (at the end of each feature), `FITS-DOCS`

`AGENTS.md` already asks for API integration tests with `APIClient`. `system_design.md` says CI runs "Django pytest", so `pytest-django` is expected (`NEW-DEP` when added). `factory_boy` makes test data shorter (`NEW-DEP`, optional).

**Run tests on PostgreSQL, never SQLite.** JSONB, `select_for_update` and RLS only behave correctly on PostgreSQL.

**A professional test matrix for every cafe-scoped endpoint:**

| Case | Expected |
|---|---|
| No token | 401 |
| Super Admin token on an owner endpoint (and owner on an admin endpoint) | 403 |
| Owner of an inactive cafe on a write endpoint | 403 + exact message |
| ID that belongs to **another cafe** | 404 + exact body `{"detail": "Not found."}` |
| ID of a soft-deleted row | 404 |
| Plan limit reached | 403 + exact message |
| Happy path | Exact status code and exact response shape from `use_cases.md` |

The "another cafe" row is the most important test in the project. It is OWASP API risk number 1 (Section 6).

---

## 4. Frontend (Next.js)

### 4.1 Customer menu page (the most important page)

**Who uses it:** a customer at a table, on a phone, often on a slow or unstable mobile connection. In 2026 reports, Syrian connectivity is still limited by power cuts and uneven coverage outside the big cities. Design for that.

**Text first, light page** -- `FRONTEND`, `FITS-DOCS`.
- Render the menu as HTML on the server. The customer should see prices before any image or large JavaScript bundle loads.
- Lazy-load images below the first screen. Give every image a fixed size or aspect ratio so the page does not jump while images load.
- Test with Chrome DevTools network throttling ("Slow 4G" and "3G") and Lighthouse.

**Language toggle without a new request** -- `FRONTEND`, `FITS-DOCS`.
The API already returns both languages in one response. Switch language in the browser and remember the choice in `localStorage`. This keeps one cached page per cafe. (URL prefixes like `/ar/` and `/en/` matter for search engines, but the menu is `noindex`, so we do not need them.)

**ISR trap 1: the `?table=N` parameter** -- `FRONTEND`, `FITS-DOCS` (important).
**ISR (Incremental Static Regeneration)** means Next.js builds the page once, caches it, and rebuilds it in the background later. In the App Router, if a page reads `searchParams` on the server, Next.js renders it fresh on every request, so ISR is lost. Read `table` in a small client component (`useSearchParams`) instead, so the server page stays cacheable.

**ISR trap 2: "immediately reflected" vs caching** -- `FRONTEND`, `DECISION`.
UC-OWNER-005 says an availability change is "immediately reflected on the public menu". Time-based ISR serves the old page until the next rebuild. The professional fix is **on-demand revalidation**: after a successful write, call a secret-protected Next.js route that runs `revalidateTag("menu:<slug>")`. Keep a short time-based fallback too.
- Next.js 16 changed these APIs (`cacheComponents`, `"use cache"`, `cacheTag`, `revalidateTag` now needs a second argument, new `updateTag`). Read the docs for the exact version you install.
- See Open Question 2.

**Contrast-safe brand color** -- `FRONTEND`, `FITS-DOCS`.
An owner may pick a light yellow `primary_color`. White text on it becomes unreadable. Compute the contrast ratio (WCAG requires 4.5:1 for normal text) and choose black or white text automatically.

**Offline support (PWA)** -- `FRONTEND`, `FITS-DOCS` (README and plan step 9 mention PWA).
A service worker can keep the last menu the customer opened. If the connection drops, the page still shows it. When showing a cached copy, display a small note: "You are offline. Prices may have changed." Do not cache dashboard API responses.

**Extra `noindex`** -- `LAUNCH`, `FITS-DOCS`.
Besides the `<meta name="robots">` tag, add the `X-Robots-Tag: noindex, nofollow` response header in Nginx for `/menu/`. It also covers non-HTML responses.

**Stable QR links ("dynamic QR")** -- `LATER`, `DECISION`.
Commercial products print a short, permanent link and redirect it to the current menu. Then printed codes survive any change. Today a slug change breaks every printed code (UC-ADMIN-006 accepts this). Because `qr_token` is already stored, a future short URL such as `/t/<qr_token>` could fix this without reprinting. The docs say the token is not in the URL in the MVP, so do not build it now.

**UX patterns seen in most professional menus** -- `FRONTEND`, `FITS-DOCS`:
- Sticky horizontal category bar that scrolls with the page and highlights the current category (must work right-to-left).
- Touch targets at least 44-48 px. Base font at least 16 px.
- Tap an item to see a larger photo and the full description.
- Clear "featured" and "new" badges (the data already has `is_featured` and `is_new`).

### 4.2 Arabic and right-to-left (RTL) -- `FRONTEND`, `FITS-DOCS`

- Set `<html lang="ar" dir="rtl">` (or `en`/`ltr`) from the active language.
- Use Tailwind **logical** classes: `ms-*`/`me-*` (margin start/end), `ps-*`/`pe-*`, `text-start`. Avoid `ml-*`/`mr-*`/`text-left`. Logical classes flip automatically in RTL.
- Flip only direction icons (arrows, chevrons). Do not flip logos, search icons or photos.
- Self-host an Arabic font with `next/font` (for example IBM Plex Sans Arabic, Cairo or Tajawal) and load only the subsets you need.
- Owner-typed text can mix Arabic and English (for example a brand name). Put `dir="auto"` on elements that show owner text, and wrap prices in `<bdi>` so numbers do not jump to the wrong side.
- Digits: `Intl.NumberFormat` with an Arabic locale may show Arabic-Indic digits in some browsers and Western digits in others. Set `numberingSystem` explicitly (`"latn"` or `"arab"`) so every browser agrees. See Open Question 4.
- Times are stored in UTC (`TIME_ZONE = 'UTC'`, correct). Display them in `Asia/Damascus` in the dashboards.

### 4.3 Dashboards -- `FRONTEND`

- **Optimistic UI** for the availability toggle: flip the switch at once, send the request, and flip it back with an error message if the request fails. UC-OWNER-005 mentions this intent. `FITS-DOCS`.
- **Drag-and-drop reorder** with a library that supports keyboard use (for example `dnd-kit`, `NEW-DEP`). Send the full `ordered_ids` list once after the drop, not on every movement.
- **Show DRF field errors next to the right form field.** DRF returns `{"field_name": ["message"]}` for 400 errors.
- **Typed API client** -- `NEW-DEP`. `drf-spectacular` generates an OpenAPI description of the Django API. `openapi-typescript` turns it into TypeScript types. When a serializer changes, the TypeScript compiler shows every frontend line that must change. This is how professional Django + Next.js teams keep both sides in sync.
- **UI translations** for dashboard labels with a library such as `next-intl` (`NEW-DEP`).

---

## 5. Deployment and Operations

| Practice | When | Kind | Why |
|---|---|---|---|
| Add a `.gitignore` (`__pycache__/`, `*.pyc`, `.env`, `venv/`, `media/`, `staticfiles/`) and stop tracking committed `.pyc` files | NOW | FITS-DOCS | Compiled files and secrets must never be in git. |
| Add `backend/.env.example` with every variable that `settings.py` reads | NOW | FITS-DOCS | Required by `AGENTS.md` Section 5. New developers and the server need it. |
| Docker images: multi-stage build, run as a non-root user, add `HEALTHCHECK` | LAUNCH | FITS-DOCS | Smaller images. A hacked process gets fewer rights. Compose can wait until the database is ready (`depends_on: condition: service_healthy`). |
| Docker log rotation (`max-size`, `max-file`) | LAUNCH | FITS-DOCS | On a small VPS, unlimited logs eventually fill the disk and stop the database. |
| Run `migrate` as a separate step before starting the new backend | LAUNCH | FITS-DOCS | A failed migration should stop the deploy, not crash a running site. |
| Never edit a migration that already ran in production | Always | FITS-DOCS | Write a new migration instead. |
| Encrypt backups before upload; keep them in a separate bucket with separate keys | LAUNCH | FITS-DOCS | A leaked backup is a full data leak. |
| **Practice a restore** every month | LAUNCH | FITS-DOCS | A backup you have never restored is not a proven backup. |
| `python manage.py check --deploy` in CI | LAUNCH | FITS-DOCS | Django's built-in production security checklist. |
| `makemigrations --check --dry-run` in CI | LAUNCH | FITS-DOCS | Fails the build if someone changed a model but forgot the migration. |
| Uptime check on the public menu and an API health URL | LAUNCH | FITS-DOCS | You learn about outages before the cafe owner calls you. |
| Error tracking (Sentry free tier, or self-hosted GlitchTip) | LAUNCH | NEW-DEP | You see the real error and stack trace when a 500 happens. |
| `pip-audit` (Python) and `npm audit` in CI | LAUNCH | NEW-DEP | Warns about known security holes in dependencies (see Section 6.2). |
| Persistent database connections: `CONN_MAX_AGE=60` + `CONN_HEALTH_CHECKS=True` | LATER | FITS-DOCS | Saves opening a new connection on every request. If RLS is added, the tenant setting must then be transaction-local (Section 7). |
| Move from `psycopg2-binary` to `psycopg[binary,pool]` (psycopg 3) | LATER | NEW-DEP | Django recommends psycopg 3 and says psycopg2 support will likely be removed in the future. psycopg 3 also enables Django's built-in connection pool. |

---

## 6. Security Checklist

### 6.1 OWASP API Security Top 10 (2023) mapped to this project

| Risk | What it means | Our defense |
|---|---|---|
| API1 Broken Object Level Authorization (BOLA) | User A reads or changes user B's object by changing an ID. | Always filter by `request.user.cafe`; return 404 for other cafes; test every endpoint with another cafe's ID; RLS later. |
| API2 Broken Authentication | Weak login, stolen tokens. | Short access tokens, rotation, blacklist, login rate limit, HttpOnly cookie storage. |
| API3 Broken Object Property Level Authorization | Client sets fields it should not ("mass assignment"), or sees fields it should not. | Serializers list fields explicitly (never `fields = "__all__"`); `cafe`, `sort_order`, `deleted_at`, `is_active` are read-only for owners; `slug` in owner settings is rejected (UC-OWNER-009 A1). |
| API4 Unrestricted Resource Consumption | One client uses all CPU, memory or disk. | Upload size limits, `table_count <= 200`, decompression-bomb limit, throttles, pagination on admin lists. |
| API5 Broken Function Level Authorization | A normal user calls an admin function. | `IsSystemAdmin` on every `/api/v1/admin/` view, based on `role`, not `is_staff`. |
| API7 Server-Side Request Forgery | The server fetches a URL chosen by the user. | Never download from a user-supplied URL. Restrict admin `logo_url` to our R2 domain. |
| API8 Security Misconfiguration | Debug mode, missing headers. | `DEBUG=False`, `check --deploy`, HSTS and security headers in Nginx, Django 6 built-in CSP for Django-rendered pages. |
| API9 Improper Inventory Management | Forgotten or undocumented endpoints. | `/api/v1/` versioning (done); an OpenAPI schema (Section 4.3). |
| API10 Unsafe Consumption of APIs | Trusting third-party services blindly. | Handle R2 failures with 502 (UC-OWNER-006 A4); time out external calls. |

### 6.2 Dependency versions in `backend/requirements.txt` -- `NOW`, needs its own turn

| Package | Current range | Issue found | Suggestion |
|---|---|---|---|
| `gunicorn` | `>=21.2,<22.0` | The whole allowed range is below the fixes for CVE-2024-1135 (fixed in 22.0.0) and CVE-2024-6827 (fixed in 23.0.0 according to the Debian tracker). Both are HTTP request smuggling bugs. | Allow `>=23.0`. |
| `Pillow` | `>=11.3,<13.0` | CVE-2026-55380 affects versions before 12.3.0 (GD format skipped the decompression-bomb check). Restricting `formats=` in `Image.open` also blocks it. | Raise the minimum to `>=12.3`. |
| `qrcode` | missing | UC-OWNER-007 says preview images are made with the `qrcode` library. | Add it in the QR feature turn. |

---

## 7. Row-Level Security (RLS) -- `LATER`, `DECISION`

The docs choose "Shared tables + RLS + `cafe_id` FK". The current code has the `cafe_id` part but no RLS yet. **RLS** is a PostgreSQL feature: the database itself hides rows that do not belong to the current tenant, even if the application forgets a filter. It is a second safety net, not a replacement for ORM filtering.

How professional Django implementations do it:
1. Enable RLS on each tenant table, and also `FORCE ROW LEVEL SECURITY`. Without `FORCE`, the table owner (often the app's own database user) skips the policies.
2. Policy example: `USING (cafe_id = current_setting('app.cafe_id', true)::bigint)`. The `true` means "return NULL if not set", so a request without a tenant sees **zero rows** ("fail closed").
3. Set the value **per transaction**: `SELECT set_config('app.cafe_id', %s, true)`. The last `true` makes it transaction-local. A session-wide value can leak to the next request that reuses the same pooled connection.
4. The app's database user must not be a superuser, must not have `BYPASSRLS`, and should not own the tables. Migrations run with a separate owner user.

**Problems specific to this project** (why this needs its own design note):
- Libraries such as `django-rls-tenants` set the tenant in Django middleware "after `AuthenticationMiddleware`". But our login is JWT through DRF. DRF authenticates inside the view, **after** all middleware has run. So the middleware would not know the user. The tenant would have to be set inside the view or service instead.
- The public menu (no user) and Super Admin endpoints (all cafes) need their own policy or database role.
- `set_config(..., true)` only lasts inside a transaction, so every request that touches tenant tables must run inside `transaction.atomic()` (or `ATOMIC_REQUESTS = True`).

See Open Question 7.

---

## 8. Product Lessons From Competitors

These are **questions to check with real cafe owners**, not tasks. Do not build them without a docs change.

- **Paid tiers.** Competitors charge for branding, photos and extra languages. Our Basic/Pro flags follow the same pattern, so the plan design is market-normal.
- **Billing.** International products use card payments. Our manual activation by the Super Admin (`implementation_plan.md`) is a sensible fit for the local payment situation.
- **Features common in menu-only tiers that we do not have:**
  - item sizes or variants with different prices (small/medium/large drinks),
  - dietary or allergen labels,
  - cafe info on the menu page (opening hours, location link, phone or WhatsApp link, Instagram),
  - search inside the menu,
  - showing sold-out items greyed out instead of hidden (our docs hide them: UC-GUEST-001).
- **Price entry after redenomination.** Owners may still think in old pounds. A hint in the item form ("prices in new Syrian pounds") may prevent 100x pricing mistakes.
- **Deliberately out of MVP scope** (`AGENTS.md` Section 5): ordering, table sessions, analytics, staff accounts, Redis. Competitors sell these. We skip them on purpose to ship a reliable core first.

---

## 9. Skills Needed for This Project

Ordered roughly by when the build plan needs them.

### 9.1 Backend (needed now)

| Skill | Why it matters here | Level |
|---|---|---|
| Python type hints, keyword-only arguments, exceptions | Clean service functions | Solid |
| Django ORM: `filter`, `Q`, `F`, `select_related`, `prefetch_related` with `Prefetch` | Tenant filtering; the 3-query public menu | Solid |
| Django transactions: `atomic`, `select_for_update`, `on_commit` | Plan limits, reorder, image replacement | Solid |
| Model constraints and migrations (`UniqueConstraint`, `CheckConstraint`, reading generated migrations) | Data rules enforced by PostgreSQL | Solid |
| DRF: serializers (input/output), permissions, throttles, exceptions, `APIClient` tests | Every endpoint | Solid |
| JWT basics: claims, expiry, rotation, blacklist, XSS vs CSRF | Auth layer and frontend token storage | Good understanding |
| PostgreSQL: JSONB, indexes, `EXPLAIN ANALYZE`, row locks, RLS, `pg_dump`/`pg_restore` | Performance, isolation, backups | Working knowledge |
| Pillow: open, verify, resize, convert, save | Upload pipeline | Basic |
| S3 API concepts with boto3/django-storages: buckets, object keys, public vs signed URLs, `Cache-Control`, CORS | Cloudflare R2 | Basic |
| ReportLab: canvas, page sizes, drawing shapes and the QR widget | QR PDF | Basic |

### 9.2 Frontend (next phase)

| Skill | Why it matters here | Level |
|---|---|---|
| TypeScript | Safe code and typed API client | Solid |
| React: state, effects, `Suspense`, forms | Dashboards | Solid |
| Next.js App Router: server vs client components, route handlers, caching and revalidation | ISR menu, BFF auth | Solid |
| Tailwind CSS with logical properties; RTL layout | Arabic-first UI | Solid |
| i18n and number/date formatting with `Intl` | Two languages, SYP prices, Damascus time | Working knowledge |
| Web performance: Lighthouse, Core Web Vitals, network throttling | Slow mobile networks | Working knowledge |
| Accessibility: contrast, touch targets, keyboard use | Customers and owners | Working knowledge |
| Service workers / PWA basics | Offline menu | Basic |

### 9.3 DevOps (deployment phase)

| Skill | Why it matters here | Level |
|---|---|---|
| Linux server basics: SSH keys, users, firewall (`ufw`), updates | The VPS | Working knowledge |
| Docker and Docker Compose | All services | Solid |
| Nginx: reverse proxy, TLS with Let's Encrypt, `limit_req`, headers, `client_max_body_size` | Single entry point | Working knowledge |
| GitHub Actions: services (PostgreSQL), secrets, SSH deploy | CI/CD | Working knowledge |
| Backups and restore drills, cron | Data safety | Working knowledge |
| Logs and monitoring | Finding problems early | Basic |

### 9.4 Engineering habits

- Read the use case before coding, and turn each alternate flow into a test case.
- Small branches and pull requests; Conventional Commit messages (already in `AGENTS.md`).
- Read release notes before upgrading Django, Next.js or simplejwt. Next.js caching APIs in particular change between major versions.
- Write short decision records: when a decision changes, update the docs in their own turn (already in `AGENTS.md`).
- Security thinking: for every endpoint ask "What if the ID belongs to another cafe?"

### 9.5 Product and people skills

- Talking with cafe owners: watch them edit a menu on their own phone.
- Arabic UX writing: short, clear, friendly labels and error messages.
- A simple support process: how an owner reports a problem and how fast you answer.

---

## 10. Prioritized Action List

| # | Suggestion | When | Kind | Section |
|---|---|---|---|---|
| 1 | Lock the cafe row (`select_for_update`) for plan-limit checks, `sort_order`, reorder and `sync_tables` | NOW | FITS-DOCS | 3.3 |
| 2 | Raise DRF built-in exceptions from services with the exact doc messages | NOW | FITS-DOCS | 3.2 |
| 3 | Public menu in about 3 queries with `Prefetch`; lock it with `assertNumQueries` | NOW | FITS-DOCS | 3.5 |
| 4 | Test matrix with "another cafe's ID -> 404" for every endpoint, on PostgreSQL | NOW | FITS-DOCS | 3.9 |
| 5 | `.gitignore`, untrack `.pyc` files, add `backend/.env.example` | NOW | FITS-DOCS | 5 |
| 6 | Raise `gunicorn` (>=23) and `Pillow` (>=12.3) minimum versions | NOW | requirements turn | 6.2 |
| 7 | Upload pipeline: check content with Pillow, random R2 keys, immutable cache header, delete old file on commit | Upload feature | FITS-DOCS | 3.7 |
| 8 | Require `R2_CUSTOM_DOMAIN` when `USE_S3=True` (avoid expiring signed URLs) | Upload feature | FITS-DOCS | 3.7 |
| 9 | QR: error correction M/Q, border 4, at least 2.5-3 cm, vector QR in the PDF | QR feature | FITS-DOCS | 3.8 |
| 10 | Login rate limit (Nginx `limit_req` + DRF throttle with `DatabaseCache`) | LAUNCH | FITS-DOCS | 3.6 |
| 11 | Daily `flushexpiredtokens` | LAUNCH | FITS-DOCS | 3.6 |
| 12 | Decide Django admin exposure in Nginx | LAUNCH | DECISION | 3.6 |
| 13 | On-demand revalidation for the menu page; read `?table` on the client | FRONTEND | DECISION | 4.1 |
| 14 | BFF cookie token storage + single-flight refresh | FRONTEND | DECISION | 3.6 |
| 15 | OpenAPI schema + generated TypeScript types | FRONTEND | NEW-DEP | 4.3 |
| 16 | Re-encode uploads to resized, metadata-free WebP | Upload feature | DECISION | 3.7 |
| 17 | Backup encryption and monthly restore drill | LAUNCH | FITS-DOCS | 5 |
| 18 | RLS design note (JWT-in-DRF problem, public and admin access) | LATER | DECISION | 7 |

---

## 11. Open Questions for the Docs

**All questions below were answered on 2026-10-12.** The answers now live in the source-of-truth docs; the pointers are given after each question. "GC" means a Global Convention in `use_cases.md`.

1. **Active-cafe rule.** UC-OWNER-001 says writes need an active cafe. UC-OWNER-006, 007, 009 and 010 do not list it as a precondition. Do image upload, QR generation and settings updates require an active cafe?
   **Resolved:** every dashboard endpoint except GET settings requires an active cafe (GC 5).
2. **"Immediately reflected" (UC-OWNER-005) vs ISR caching.** What is the longest acceptable delay before a change appears on the public menu?
   **Resolved:** on-demand revalidation called by Django after commit, 5-minute fallback (GC 9, `system_design.md` §3.5).
3. **Language keys.** Which keys are required in `name` and `description` (`ar` only? both?). What does a customer see when the chosen language is empty?
   **Resolved:** `ar` required, `en` optional, unknown keys rejected, fallback to `ar` (GC 6).
4. **Price display.** After the 2026 redenomination: show decimals or not? Western digits or Arabic-Indic digits?
   **Resolved:** Western digits, trailing `.00` hidden, SYP label (GC 10).
5. **Admin `logo_url`.** Should UC-ADMIN-006 accept any URL, or only URLs on the R2 custom domain?
   **Resolved:** `logo_url` removed from the admin PATCH; logos come only from the owner upload (UC-ADMIN-006 A4).
6. **Token storage on the frontend.** BFF with HttpOnly cookies, or another approach?
   **Resolved:** BFF with HttpOnly cookies and single-flight refresh (`system_design.md` §3.6).
7. **RLS timing and design.** When is RLS built, and where is the tenant set, given that JWT authentication runs inside DRF and not in Django middleware?
   **Resolved:** post-MVP hardening; design notes in `system_design.md` §7.1.
8. **Error shape in UC-OWNER-007.** A1 uses a field-level error on `table_count`; A2 uses `{"detail": ...}` for the same field. Is that intended?
   **Resolved:** A2 is field-level too, with DRF's built-in max_value message (UC-OWNER-007 A2).

Also decided on 2026-10-12: keep stored images/logo/color after a downgrade and hide them from customers (GC 7); re-encode uploads to WebP (UC-OWNER-006); Django admin at a path from env `DJANGO_ADMIN_PATH`.

---

## 12. Sources

Similar systems
- FeastQR: https://github.com/jakubczarnowski/FeastQR
- workouse/qr-menu: https://github.com/workouse/qr-menu
- MENU TIGER vs Menubly (vendor-written comparison): https://www.menutiger.com/blog/menu-tiger-vs-menubly
- QR menu app comparison: https://www.qrstuff.com/feeds/blog/qr-menu-apps-restaurants-2024

Architecture and Django
- HackSoft Django Styleguide: https://github.com/HackSoftware/Django-Styleguide
- Django 6.0 release notes: https://docs.djangoproject.com/en/6.1/releases/6.0/
- Django databases (psycopg 3, connection pool): https://docs.djangoproject.com/en/stable/ref/databases/
- simplejwt blacklist app (`flushexpiredtokens`): https://django-rest-framework-simplejwt.readthedocs.io/en/latest/blacklist_app.html
- django-axes cache caveats: https://django-axes.readthedocs.io/en/stable/4_configuration.html
- drf-spectacular: https://pypi.org/project/drf-spectacular/
- Type-safe Django + TypeScript guide: https://platform-django-template.readthedocs.io/en/latest/4-guides/type-safe-api-integration.html

Multi-tenancy and RLS
- django-rls-tenants announcement: https://forum.djangoproject.com/t/django-rls-tenants-database-enforced-multitenancy-using-postgresql-rls/44522
- flask-rls (transaction-local `set_config` pattern): https://pypi.org/project/flask-rls/
- pganalyze on RLS with Django: https://pganalyze.com/blog/postgres-row-level-security-django-python

Security
- OWASP API Top 10 overview: https://www.wiz.io/academy/api-security/owasp-api-security
- Pillow security handbook: https://pillow.readthedocs.io/en/latest/handbook/security.html
- CVE-2026-55380 (Pillow): https://vulert.com/vuln-db/CVE-2026-55380
- CVE-2024-6827 (gunicorn): https://security-tracker.debian.org/tracker/CVE-2024-6827
- CVE-2024-1135 (gunicorn): https://www.kodemsecurity.com/cve-archive/cve-2024-1135
- Token storage (cookies vs localStorage): https://blog.openreplay.com/cookies-vs-localstorage-jwt-auth/

Frontend
- Next.js ISR: https://nextjs.org/docs/app/building-your-application/rendering/incremental-static-regeneration
- Next.js images config (custom loader): https://nextjs.org/docs/app/api-reference/config/next-config-js/images
- RTL in apps: https://evilmartians.com/chronicles/600-million-people-write-right-to-left-2-fixes-your-app-needs

Storage and images
- R2 public buckets (r2.dev limits, custom domains): https://developers.cloudflare.com/r2/buckets/public-buckets/
- R2 presigned URLs: https://developers.cloudflare.com/r2/api/s3/presigned-urls/
- Cloudflare Images pricing (free transformations): https://developers.cloudflare.com/images/pricing/

QR printing
- Minimum QR size: https://qrplanet.com/help/article/what-is-the-minimum-size-of-a-qr-code
- QR size guide: https://tritonstore.com.au/qr-code-size/

Syria context
- Redenomination: https://www.aljazeera.com/economy/2026/1/5/syrias-new-currency-removes-al-assad-family-images-seeks-to-boost-economy
- UN Treasury note on SYP: https://treasury.un.org/operationalrates/default.php
- Telecom conditions 2026: https://www.budde.com.au/Research/Syria-Telecoms-Mobile-and-Broadband-Statistics-and-Analyses
- GitHub access restored for Syria: https://github.blog/company/github-is-enabling-broader-access-for-developers-in-syria-following-new-government-trade-rules/

Note: several product and QR-printing sources are vendor blogs. Treat their numbers as rules of thumb, not standards.
