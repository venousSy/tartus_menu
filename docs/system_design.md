# System Design — Tartus Smart Digital Menu

## 1. Decisions Summary

| Topic | Decision |
|---|---|
| Architecture | Modular Monolith |
| Backend | Django + DRF |
| Frontend | Next.js (single app, Route Groups) |
| Database | PostgreSQL (shared schema, `cafe_id` isolation) |
| Auth | JWT via `simplejwt` — access 15 min, refresh 1 day, rotation + blacklist after rotation |
| Storage | Cloudflare R2 |
| Multi-tenancy | Shared tables + `cafe_id` FK; every queryset filtered by cafe + 404 masking + a cross-tenant test for every endpoint. PostgreSQL RLS is planned post-MVP (§7.1) |
| Languages | Arabic + English (JSONB fields); `ar` required, `en` optional, display falls back to `ar` |
| Currency | SYP only (hardcoded) — new Syrian pound after the 2026-01-01 redenomination; display: Western digits, trailing `.00` hidden |
| Menu levels | 2 levels: Category → Item |
| QR URL | The code holds the table's permanent short link `/t/[qr_token]`, which redirects to `/menu/[cafe-slug]?table=N` (survives a slug change) |
| QR PDF | Django (`reportlab`, vector QR widget); preview images with the `qrcode` library; error correction level Q, 4-module quiet zone |
| Tables | Persisted `CafeTable` per physical table (unique `table_number` per cafe + `qr_token`); table count is derived from active rows, no `table_count` column |
| Slug changes | Super Admin only |
| Billing | Manual activation by Super Admin |
| Analytics | Menu opens counted per cafe, hour and table (app `analytics`); no cookies and no personal data; every plan sees opens per day, a plan with `allows_detailed_analytics` (Pro) also per hour and per table |
| Reverse Proxy | Nginx + Let's Encrypt |
| Deployment | Docker Compose on VPS |
| CI/CD | GitHub Actions → SSH → restart containers |
| DB Backups | Daily `pg_dump` → Cloudflare R2 |
| API versioning | `/api/v1/` |
| API errors | Standard DRF format; a whole-request error (`{"detail": "..."}`) also names its machine-readable code in the `X-Error-Code` header (for example `images_need_pro`), which the frontend translates by |
| Public menu caching | Next.js ISR + on-demand revalidation called by Django after commit (§3.5); 5-minute time-based fallback |
| Frontend auth | BFF: Next.js server routes keep the JWT pair in HttpOnly cookies; single-flight refresh (§3.6) |
| Rate limiting | Nginx `limit_req` on login paths + DRF `ScopedRateThrottle` (scope `login`, 5/min per client IP) stored in Django `DatabaseCache` (no Redis) |
| Email | Only the password reset email (UC-AUTH-006): Django's `EmailMessage` over SMTP, settings from the environment (`EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `DEFAULT_FROM_EMAIL`), provider Resend; off when `EMAIL_HOST` is empty (the endpoint then answers 503); development prints the email to the console |
| Image uploads | Validated by content with Pillow, resized, metadata removed, stored as WebP under random keys (`cafes/<cafe_id>/...`), served from the R2 custom domain; item images also get a 192 px thumbnail for the menu lists |
| Django admin site | Non-obvious path from env `DJANGO_ADMIN_PATH`, routed by Nginx |
| Inactive cafe | Every dashboard endpoint except GET settings answers 403 |
| Plan downgrade | Stored images, logo and color are kept and hidden from customers until the plan allows them again |
| Empty values | `''` (not NULL) means "none" for `image_url`, `logo_url` and `primary_color` |

---

## 2. Database Schema (ERD)

### 2.1 Users & Auth

```
users (custom User model `users.User`; every FK to "auth_user.id" in this document refers to this model)
├── id (PK)
├── email          UNIQUE
├── password       (hashed)
├── role           VARCHAR(20)  -- 'SYSTEM_ADMIN' (Super Admin) | 'CAFE_OWNER' | 'CAFE_STAFF' (out of MVP scope)
├── is_staff       BOOLEAN      -- True for SYSTEM_ADMIN only; Django admin site access
├── is_active
└── date_joined
```

### 2.2 Core Tables

```
subscription_plans
├── id (PK)
├── name             VARCHAR(50)   -- 'basic' | 'pro'
├── max_categories   INT           -- NULL = unlimited
├── max_items        INT           -- NULL = unlimited
├── allows_images    BOOLEAN       -- item images
├── allows_branding  BOOLEAN       -- logo + primary color
└── allows_detailed_analytics  BOOLEAN  -- menu opens per hour and per table (default false)
```

```
cafes
├── id              PK
├── owner_id        FK → auth_user.id (OneToOne)
├── plan_id         FK → subscription_plans.id
├── slug            VARCHAR(100) UNIQUE
├── name            JSONB        -- {"ar":"...", "en":"..."}
├── primary_color   VARCHAR(7)   -- "#RRGGBB" (e.g. "#FF5733") or '' = default theme; CHECK
├── logo_url        TEXT         -- R2 custom-domain URL; '' = no logo
├── is_active       BOOLEAN      DEFAULT false
├── subscription_start_at  TIMESTAMPTZ NULL
├── subscription_end_at    TIMESTAMPTZ NULL  -- the moment of the last deactivation (manual or automatic)
├── subscription_expires_on  DATE NULL       -- last paid day, in the business time zone; NULL = no end date
├── created_at      TIMESTAMPTZ  DEFAULT now()
└── updated_at      TIMESTAMPTZ  DEFAULT now()
```

> `subscription_expires_on` is a calendar day, not a moment: the cafe is active through that whole day in `Asia/Damascus` (setting `BUSINESS_TIME_ZONE`; Django's `TIME_ZONE` and the database stay UTC). The nightly job deactivates cafes whose day has passed (use_cases.md Global Convention 5, UC-ADMIN-012).

```
cafe_tables
├── id            PK
├── cafe_id       FK → cafes.id  (CASCADE DELETE)
├── table_number  INT            -- 1..200 (CHECK)
├── qr_token      UUID           -- UNIQUE, uuid4, generated once, never regenerated
├── is_active     BOOLEAN        DEFAULT true
├── created_at    TIMESTAMPTZ    DEFAULT now()
├── updated_at    TIMESTAMPTZ    DEFAULT now()
└── UNIQUE (cafe_id, table_number)
```

> `cafes` has NO `table_count` column. The table count is always `COUNT(*)` of `cafe_tables` rows with `is_active = true` for the cafe.

```
categories
├── id          PK
├── cafe_id     FK → cafes.id  (CASCADE DELETE)
├── name        JSONB        -- {"ar":"...", "en":"..."}
├── sort_order  INT          -- Gapped: 100, 200, 300
├── is_visible  BOOLEAN      DEFAULT true
├── deleted_at  TIMESTAMPTZ  NULL  -- Soft delete
├── created_at  TIMESTAMPTZ  DEFAULT now()
└── updated_at  TIMESTAMPTZ  DEFAULT now()
```

```
menu_items
├── id            PK
├── category_id   FK → categories.id  (CASCADE DELETE)
├── cafe_id       FK → cafes.id       (denormalized for RLS)
├── name          JSONB        -- {"ar":"...", "en":"..."}
├── description   JSONB        -- {"ar":"...", "en":"..."}
├── price         NUMERIC(10,2) -- new SYP; CHECK price >= 0
├── image_url     TEXT         -- R2 custom-domain URL; '' = no image (hidden from customers while plan.allows_images is false)
├── thumbnail_url TEXT         -- the same image, longest side 192 px, for the small list pictures; '' = none (APIs then return image_url)
├── is_available  BOOLEAN      DEFAULT true
├── is_featured   BOOLEAN      DEFAULT false
├── is_new        BOOLEAN      DEFAULT false
├── tags          TEXT[]       DEFAULT '{}'  -- codes from the fixed list of use_cases.md Global Convention 11
├── sort_order    INT          -- Gapped: 100, 200, 300
├── deleted_at    TIMESTAMPTZ  NULL  -- Soft delete
├── created_at    TIMESTAMPTZ  DEFAULT now()
└── updated_at    TIMESTAMPTZ  DEFAULT now()
```

> JSONB text fields (`name`, `description`) follow use_cases.md Global Convention 6: in `name`, `ar` is required and non-empty and `en` is optional; no other keys are allowed. String fields that can be "none" (`image_url`, `logo_url`, `primary_color`) use `''`, never NULL.

```
menu_item_variants               -- sizes or options of one item, each with its own price
├── id          PK
├── item_id     FK → menu_items.id  (CASCADE DELETE)
├── cafe_id     FK → cafes.id       (CASCADE DELETE; denormalized for RLS, always the item's cafe)
├── name        JSONB         -- {"ar":"...", "en":"..."}, at most 50 characters per language
├── price       NUMERIC(10,2) -- new SYP; CHECK price >= 0
├── sort_order  INT           -- Gapped: 100, 200, 300, in the order the owner sent
├── created_at  TIMESTAMPTZ   DEFAULT now()
└── updated_at  TIMESTAMPTZ   DEFAULT now()
```

> An item has 0 to 10 variants (use_cases.md Global Convention 10). They are written only as a whole list with their item: the old rows are deleted and the new ones inserted in one transaction, so a variant `id` is not stable. While an item has variants, `menu_items.price` holds the lowest variant price (set by the service), so every reader that needs one price still finds it there.

> `menu_items.tags` is a PostgreSQL array (Django `ArrayField`), not a separate table: the list of codes is fixed and short (6), an item is always read together with its tags, and nothing else refers to a tag. Stored without repeats, in the order of the fixed list; no tags is `'{}'`, never NULL.

```
billing_events
├── id          PK
├── cafe_id     FK → cafes.id
├── action      VARCHAR(20)  -- 'activated' | 'deactivated' | 'plan_changed' | 'renewed' | 'expired'
├── notes       TEXT
├── performed_by_id  FK → auth_user.id  -- NULL: written by the system ('expired'), or the admin account was deleted
└── created_at  TIMESTAMPTZ  DEFAULT now()
```

```
menu_view_counts                 -- app "analytics" (use_cases.md UC-GUEST-004)
├── id            PK
├── cafe_id       FK → cafes.id  (CASCADE DELETE)
├── hour          TIMESTAMPTZ    -- start of the hour, UTC
├── table_number  SMALLINT       -- 1..200, or 0 = no table; CHECK 0..200
├── count         INT            -- menu opens in that hour from that table
└── UNIQUE (cafe_id, hour, table_number)
```

> One row per cafe, hour and table: a counter, not a log of visits. A menu open runs `UPDATE ... SET count = count + 1` on its row (created on the first open of the hour). Nothing about the visitor is stored. Rows older than 400 days are deleted every night.

### 2.3 Delete & Isolation Policies

| Table | Delete Policy | Isolation |
|---|---|---|
| `cafes` | Hard delete (cascades) | `owner_id` |
| `cafe_tables` | Deactivate (`is_active = false`); rows are removed only by the cafe CASCADE | `cafe_id` |
| `categories` | **Soft delete** (`deleted_at`) | `cafe_id` |
| `menu_items` | **Soft delete** (`deleted_at`) | `cafe_id` |
| `menu_item_variants` | Hard delete: replaced as a whole list on an item write; with the item or the cafe (CASCADE). No `deleted_at`: a soft-deleted item keeps its rows, hidden with it | `cafe_id` |
| `billing_events` | Hard delete (audit log, not user-facing) | `cafe_id` |
| `menu_view_counts` | Hard delete: with the cafe (CASCADE), and by age (400 days) | `cafe_id` |

---

## 3. API Contract — `/api/v1/`

### 3.1 Auth

| Method | Endpoint | Actor | Description |
|---|---|---|---|
| POST | `/api/v1/auth/login/` | Any | Obtain JWT access + refresh tokens |
| POST | `/api/v1/auth/refresh/` | Any | Exchange refresh token for a new access + refresh pair (old refresh is blacklisted) |
| POST | `/api/v1/auth/logout/` | Any | Blacklist refresh token |
| POST | `/api/v1/auth/change-password/` | Any | Change own password; blacklists all outstanding refresh tokens |
| POST | `/api/v1/auth/password-reset/` | Cafe Owner (no login) | Ask for a reset link by email (UC-AUTH-006); always `204` for a well-formed address |
| POST | `/api/v1/auth/password-reset/confirm/` | Cafe Owner (no login) | Set a new password with a one-time reset link (UC-AUTH-005); blacklists all outstanding refresh tokens |

**Login Request:**
```json
{ "email": "owner@cafe.com", "password": "secret" }
```
**Login Response:**
```json
{
  "access": "<jwt_access_token>",
  "refresh": "<jwt_refresh_token>",
  "role": "CAFE_OWNER"
}
```

**Password Reset Confirm Request** (`uid` and `token` are the two parts of the reset link after the `#`, separated by a dot):
```json
{ "uid": "MTI", "token": "d2x4ab-0123456789abcdef0123456789abcdef", "new_password": "a-new-strong-pass" }
```
Answers `204 No Content`. An invalid, expired or used link: `400 {"detail": "This reset link is invalid or has expired."}` with `X-Error-Code: reset_link_invalid`. Throttle scope `password_reset` (5/min per client IP).

**Password Reset Email Request** (UC-AUTH-006):
```json
{ "email": "owner@cafe.com" }
```
Answers `204 No Content` whether the address has an account or not; an email with the reset link goes only to an active Cafe Owner account, at most once per 5 minutes. Email not set up on the server (`EMAIL_HOST` empty): `503 {"detail": "Password reset by email is not available. Please contact support."}` with `X-Error-Code: email_not_configured`. Throttle scope `password_reset_email` (5/hour per client IP).

---

### 3.2 Super Admin — Cafes Management

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/admin/cafes/` | List all cafes (paginated) |
| POST | `/api/v1/admin/cafes/` | Create a new cafe + owner account |
| GET | `/api/v1/admin/cafes/{id}/` | Get cafe details |
| PATCH | `/api/v1/admin/cafes/{id}/` | Update cafe details / plan / slug (not is_active, not logo_url) |
| DELETE | `/api/v1/admin/cafes/{id}/` | Hard delete a cafe and its owner user |
| POST | `/api/v1/admin/cafes/{id}/activate/` | Activate subscription |
| POST | `/api/v1/admin/cafes/{id}/deactivate/` | Deactivate subscription |
| POST | `/api/v1/admin/cafes/{id}/renew/` | Move the end date of an active subscription (UC-ADMIN-011) |
| GET | `/api/v1/admin/cafes/{id}/billing/` | Get billing history |
| POST | `/api/v1/admin/cafes/{id}/password-reset-link/` | Make a one-time password reset link for the cafe's owner (UC-ADMIN-010) |
| GET | `/api/v1/admin/stats/` | Platform summary stats |

**Create Cafe Request:**
```json
{
  "slug": "tartus-coffee",
  "name": { "ar": "قهوة طرطوس", "en": "Tartus Coffee" },
  "plan": "pro",
  "owner": {
    "email": "owner@tartuscoffee.com",
    "password": "initial_pass"
  }
}
```

**Activate / Renew Request** (`expires_on` is required: the last paid day, today or later and at most 2 years ahead; `notes` is optional, at most 500 characters, stored on the BillingEvent):
```json
{ "expires_on": "2027-02-10", "notes": "Paid 3 months in cash." }
```

**Deactivate Request** (optional body):
```json
{ "notes": "Did not pay for May." }
```

The cafe object of the admin API carries `subscription_expires_on` (`"2027-02-10"` or `null`) and `days_left` (a number, or `null` for an inactive cafe or one without an end date). `GET /api/v1/admin/stats/` also returns `expiring_soon_cafes`.

**Password Reset Link Response** (no request body; nothing is stored, the link is valid for 24 hours and dies when the password changes):
```json
{
  "url": "https://menu.domain.com/reset-password#MTI.d2x4ab-0123456789abcdef0123456789abcdef",
  "expires_at": "2026-11-11T09:30:00Z"
}
```

---

### 3.3 Cafe Owner — Dashboard

#### Categories

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/dashboard/categories/` | List all categories (excl. soft-deleted) |
| POST | `/api/v1/dashboard/categories/` | Create a category |
| PATCH | `/api/v1/dashboard/categories/{id}/` | Update name / visibility |
| DELETE | `/api/v1/dashboard/categories/{id}/` | Soft delete |
| POST | `/api/v1/dashboard/categories/reorder/` | Bulk reorder (Gapped Integer) |

**Reorder Request:**
```json
{ "ordered_ids": [3, 1, 2] }
```

#### Menu Items

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/dashboard/items/` | List items (filter by category) |
| POST | `/api/v1/dashboard/items/` | Create item (`tags` optional: a list of tag codes; `variants` optional: a list of `{name, price}`, sent instead of `price`) |
| PATCH | `/api/v1/dashboard/items/{id}/` | Update item (`tags` and `variants`, when sent, each replace their whole list) |
| DELETE | `/api/v1/dashboard/items/{id}/` | Soft delete |
| POST | `/api/v1/dashboard/items/reorder/` | Bulk reorder |
| PATCH | `/api/v1/dashboard/items/{id}/availability/` | Toggle `is_available` |
| POST | `/api/v1/dashboard/items/{id}/image/` | Upload image → R2 |

#### QR Codes

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/dashboard/qr/generate/` | Sync tables to `table_count` (create/reactivate 1..N, deactivate > N); returns active tables |
| GET | `/api/v1/dashboard/qr/preview/` | List active tables with QR codes (read-only) |
| GET | `/api/v1/dashboard/qr/download-pdf/` | Download print-ready PDF of active tables (`reportlab`) |

**Generate QR Request** (integer, 1–200):
```json
{ "table_count": 12 }
```

**Generate / Preview Response (200):**
```json
{
  "table_count": 12,
  "tables": [
    { "id": 1, "table_number": 1, "url": "https://menu.domain.com/t/<qr_token of table 1>", "qr_token": "<uuid4>", "qr_image_url": "data:image/png;base64,..." },
    { "id": 2, "table_number": 2, "url": "https://menu.domain.com/t/<qr_token of table 2>", "qr_token": "<uuid4>", "qr_image_url": "data:image/png;base64,..." }
  ]
}
```

`url` is the table's permanent short link `/t/<qr_token>`; the QR code and the PDF hold it. It redirects to `/menu/<current slug>?table=N` (§3.4, use_cases.md UC-GUEST-003), so printed codes survive a slug change.

#### Cafe Settings

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/dashboard/settings/` | Get cafe profile + plan flags + is_active + subscription_expires_on and days_left (answers 200 even when inactive) |
| PATCH | `/api/v1/dashboard/settings/` | Update name, primary_color (slug is Super Admin only) |
| POST | `/api/v1/dashboard/settings/logo/` | Upload logo → R2 |

#### Analytics

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/dashboard/analytics/summary/?days=7` | Menu opens per day (UC-OWNER-015); every plan |
| GET | `/api/v1/dashboard/analytics/detail/?days=7` | Menu opens per hour of the day and per table (UC-OWNER-016); needs `allows_detailed_analytics`, else 403 `analytics_need_pro` |

`days` is 7 (default), 30 or 90. Days and hours are in the business time zone. Missing days and hours are returned with `0`.

```json
{ "days": 7, "total": 153, "by_day": [ { "date": "2026-11-04", "count": 12 } ] }
```
```json
{
  "days": 7, "total": 153,
  "by_hour": [ { "hour": 0, "count": 0 }, { "hour": 1, "count": 2 } ],
  "by_table": [ { "table_number": 3, "count": 40 }, { "table_number": 0, "count": 21 } ]
}
```

---

### 3.4 Public — Customer Menu (No Auth)

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/menu/{slug}/` | Get full menu (cafe info + categories + items) |

**Response:**
```json
{
  "cafe": {
    "name": { "ar": "قهوة طرطوس", "en": "Tartus Coffee" },
    "primary_color": "#C0392B",
    "logo_url": "https://media.domain.com/cafes/1/logo/<uuid4>.webp",
    "is_active": true
  },
  "categories": [
    {
      "id": 1,
      "name": { "ar": "مشروبات ساخنة", "en": "Hot Drinks" },
      "sort_order": 100,
      "items": [
        {
          "id": 10,
          "name": { "ar": "إسبريسو", "en": "Espresso" },
          "description": { "ar": "قهوة مركزة", "en": "Concentrated coffee" },
          "price": "50.00",
          "image_url": "https://media.domain.com/cafes/1/items/<uuid4>.webp",
          "thumbnail_url": "https://media.domain.com/cafes/1/items/<uuid4>.webp",
          "is_available": true,
          "is_featured": true,
          "is_new": false,
          "tags": ["vegan", "gluten_free"],
          "variants": [
            { "id": 31, "name": { "ar": "صغير", "en": "Small" }, "price": "50.00" },
            { "id": 32, "name": { "ar": "كبير", "en": "Large" }, "price": "75.00" }
          ],
          "sort_order": 100
        }
      ]
    }
  ]
}
```

> When `is_active` is `false`, the API still returns 200 with `is_active: false` so the frontend can display the "Temporarily Unavailable" screen.

> Plan-gated values are hidden in this response (use_cases.md Global Convention 7): `image_url` and `thumbnail_url` are `""` while the plan has `allows_images = false`; `logo_url` and `primary_color` are `""` while it has `allows_branding = false`. `price` is a string with two decimals in new SYP (Global Convention 10). `tags` is never hidden: it holds the item's tag codes on every plan, `[]` without tags (Global Convention 11); the customer filters by the dietary ones in the browser. `variants` is never hidden either: the item's sizes in the owner's order, `[]` for an item with one price; with variants, `price` is the lowest variant price (Global Convention 10).

> The whole response costs four database queries, whatever the size of the menu: the cafe with its plan, the categories, their items, the items' variants.

> This endpoint is called by the Next.js server (ISR), not by the customer's browser. It is therefore not rate limited per client IP in DRF; Nginx rate-limits the `/menu/` pages instead.

**QR short links (use_cases.md UC-GUEST-003):**

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/qr/{qr_token}/` | Where a printed code leads now: `200 {"slug": "tartus-coffee", "table_number": 3}`; `table_number` is `null` for an inactive table; `404 {"detail": "Not found."}` for an unknown token (a malformed one matches no route) |

**Menu open counter (use_cases.md UC-GUEST-004):**

| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/v1/menu/{slug}/views/` | Body `{"table": 3}` or `{"table": null}` (also no body). Adds 1 to the counter of (cafe, current hour, table) and answers `204`. Unknown slug: `404`. Inactive cafe: `204`, not counted. A number that is not an active table of the cafe is counted as table `0`. `table` outside 1..200: `400` |

> The menu page sends it once per page load to the Next.js route `POST /menu/{slug}/views` (`navigator.sendBeacon`), which passes it to Django. No authentication, no cookie, nothing stored about the visitor. Nginx rate-limits both paths with their own zone (`views`).

> Next.js serves `GET /t/{qr_token}`: it calls this endpoint (no cache) and answers `302` with a relative `Location: /menu/<slug>?table=N`, `Cache-Control: no-store`. A 404 or a token that is not a UUID redirects to `/qr-invalid`; an unreachable Django gives `503` with `Retry-After: 60`. No authentication; Nginx rate-limits `/t/` and `/api/v1/qr/` with the menu zone.

---

### 3.5 Internal — Public Menu Revalidation (Django → Next.js)

| Method | Endpoint | Caller | Description |
|---|---|---|---|
| POST | `{FRONTEND_REVALIDATE_URL}`, e.g. `http://frontend:3000/internal/revalidate` | Django backend (Docker network only) | Rebuild the cached `/menu/[slug]` pages of the given cafes |

**Request:** header `X-Revalidate-Secret: <FRONTEND_REVALIDATE_SECRET>`
```json
{ "slugs": ["tartus-coffee"] }
```
**Response:** `200 { "revalidated": true }`; `401` when the secret is wrong.

Rules:
- Django sends it with `transaction.on_commit`, so it runs only after the write is saved. The triggers are listed in use_cases.md Global Convention 9.
- Python's built-in `urllib` is used (no new dependency), with a 2-second timeout. Any error is logged and never fails the original request.
- Next.js also revalidates the page on a time basis (at most every 5 minutes) as a fallback.
- Nginx answers 404 for `/internal/`, so the endpoint is reachable only inside the Docker network.
- New environment variables (added to `.env.example` when this is built): `FRONTEND_REVALIDATE_URL`, `FRONTEND_REVALIDATE_SECRET`.

---

### 3.6 Frontend Authentication (BFF)

BFF means "Backend For Frontend": the Next.js server sits between the browser and the Django API for everything that needs a login.

- The browser never sees a JWT. Next.js server routes call the auth endpoints of §3.1 and store `access` and `refresh` in cookies with `HttpOnly; Secure; SameSite=Strict; Path=/`.
- Next.js server code calls Django directly on the Docker network (`http://backend:8000/api/v1/...`) with `Authorization: Bearer <access>`.
- Refresh is single-flight: only one refresh call runs at a time per session, and other requests wait for its result (refresh tokens are single-use, UC-AUTH-002).
- State-changing BFF routes also check the `Origin` header (same origin only), in addition to `SameSite=Strict`.
- Nginx sets `X-Forwarded-For` with `$proxy_add_x_forwarded_for`. The BFF forwards the `X-Forwarded-For` header it received unchanged. Django reads the client IP with DRF `NUM_PROXIES` (env `DJANGO_NUM_PROXIES`, production value `1`), so login throttling sees the real customer IP on both paths (browser → Nginx → Django, and browser → Nginx → Next.js → Django).
- The Django API itself does not change: it still returns the tokens in the JSON body.

Frontend paths. None of them starts with `/api/`, because Nginx sends `/api/` to Django.

| Path | Who | What |
|---|---|---|
| `/menu/{slug}` | Customer | The public menu (§3.4), cached; `?table=N` is read in the browser only |
| `/menu/{slug}/views` | Customer's browser | POST only: reports one menu open (§3.4, UC-GUEST-004) |
| `/t/{qr_token}` | Customer | The short link in a table's QR code; redirects to the menu (§3.4, UC-GUEST-003) |
| `/qr-invalid` | Customer | "This QR code is not valid", for a code that belongs to no table |
| `/` | Anyone | Redirects to `/login` |
| `/login` | Super Admin, Cafe Owner | One login page for both roles; a visitor who is already logged in goes to their home path |
| `/dashboard/*` | Cafe Owner | The owner dashboard (§3.3) |
| `/admin/*` | Super Admin | The Super Admin pages (§3.2) |
| `/bff/auth/login`, `/bff/auth/logout`, `/bff/auth/change-password` | Browser of a logged-in user | BFF routes for UC-AUTH-001, 003 and 004; they set or clear the cookies |
| `/reset-password` | Cafe Owner (no login) | The new-password form of UC-AUTH-005. It reads `uid` and `token` from the part of the link after `#` (which the browser never sends to a server), removes them from the address bar, and sends `Referrer-Policy: no-referrer`. Not part of the proxy matcher |
| `/bff/auth/password-reset` | Browser (no login) | BFF route for UC-AUTH-005; passes the body to Django and sets no cookie |
| `/forgot-password` | Cafe Owner (no login) | The "Forgot password?" form of UC-AUTH-006, linked from `/login`. Not part of the proxy matcher |
| `/bff/auth/forgot-password` | Browser (no login) | BFF route for UC-AUTH-006; passes the body to Django and sets no cookie |
| `/bff/auth/session-ended` | Browser | Clears the cookies and opens `/login` when Django no longer accepts the session |
| `/bff/dashboard/qr-pdf` | Cafe Owner | Streams the QR codes PDF (UC-OWNER-008) |
| `/internal/revalidate` | Django only | §3.5 |
| `/health` | Uptime monitor, Docker, the deploy job | §3.7 |

### 3.7 Health Check

| Method | Endpoint | Auth | Description |
|---|---|---|---|
| GET | `/api/v1/health/` | None | Django answers and PostgreSQL runs one query (`SELECT 1`) |
| GET | `/health` (Next.js) | None | The whole chain: Nginx → Next.js → Django → PostgreSQL |

**Django:** `200 {"status": "ok"}`, or `503 {"detail": "Database unavailable."}` with `X-Error-Code: db_unavailable`. No authentication (a stale token never turns it into a 401), no DRF throttle, no business rule.

**Next.js `/health`:** asks Django's health check with a 2-second timeout and never caches the answer: `200 {"status": "ok"}`, otherwise `503 {"detail": "Service unavailable."}`. It is not part of the proxy matcher.

Who calls it:
- An external uptime monitor (for example UptimeRobot or Better Stack, free plan) on `https://<domain>/health` every few minutes; it alerts the operator when the site is down (deploy/README.md).
- Docker healthchecks: `backend` calls Django's check, `frontend` calls its own `/health`; Nginx starts only after both are healthy.
- The deploy job, after the migration: the deploy fails unless `https://<domain>/health` answers 200 within about a minute.

---

## 4. User Flows

### 4.1 Super Admin Flow
```
Login
  └── Dashboard Home (stats: total cafes, active/inactive)
        ├── Cafe List
        │     ├── Create New Cafe (name, slug, plan, owner credentials)
        │     ├── View Cafe Details (plan, status, billing log)
        │     ├── Activate / Deactivate Subscription
        │     └── Delete Cafe
        └── (Future) Analytics per cafe
```

### 4.2 Cafe Owner Flow
```
Login
  └── Dashboard Home
        ├── Categories
        │     ├── Add / Edit / Hide / Delete Category
        │     └── Drag & Drop Reorder
        ├── Menu Items (filtered by category)
        │     ├── Add / Edit / Delete Item
        │     ├── Toggle Availability (instant)
        │     ├── Upload Image
        │     └── Drag & Drop Reorder
        ├── QR Codes
        │     ├── Set Table Count
        │     ├── Preview All QR Codes
        │     └── Download Print-Ready PDF
        └── Settings
              ├── Update Cafe Name (ar/en)
              ├── Change Primary Color
              └── Upload Logo
```

### 4.3 Customer Flow
```
Scan QR Code
  └── GET /t/[qr_token] → 302 (UC-GUEST-003)
  └── GET /menu/[slug]?table=3
        ├── If active → Show Menu
        │     ├── Switch Language (ar/en, in the browser — no new request)
        │     ├── Browse Categories (horizontal tabs or accordion)
        │     └── View Item Details (name, description, price, image)
        └── If inactive → Show "Temporarily Unavailable" screen
```

---

## 5. Deployment Architecture

```
Internet
    │
    ▼
[ Nginx (port 80/443) ]  ← Let's Encrypt SSL (Certbot)
    │
    ├── /api/*                 → Django (Gunicorn, port 8000)
    │                               └── PostgreSQL (port 5432)
    ├── /<DJANGO_ADMIN_PATH>   → Django admin site
    ├── /static/*              → collected static files (Django admin assets)
    ├── /internal/*            → 404 (internal Next.js routes, Docker network only)
    ├── /health                → Next.js health check (§3.7), not logged
    │
    └── /*                     → Next.js (port 3000)
                                    └── Cloudflare R2 (image CDN, custom domain)

All services run inside Docker Compose on a single VPS.
```

### Nginx Rules

- Every proxied location sets `X-Forwarded-For $proxy_add_x_forwarded_for` and `X-Forwarded-Proto`.
- `limit_req` (per client IP) on `/api/v1/auth/login/`, the BFF login route `/bff/auth/login` (§3.6), the password reset pairs `/api/v1/auth/password-reset/confirm/` with `/bff/auth/password-reset` and `/api/v1/auth/password-reset/` with `/bff/auth/forgot-password` (same zone as the login) and the Django admin login page.
- A separate, generous `limit_req` zone (per client IP) on the `/menu/` pages (§3.4 public menu note), the QR short links `/t/` and the public APIs `/api/v1/menu/` and `/api/v1/qr/`. Many customers of one cafe may share one IP behind its Wi-Fi.
- Its own `limit_req` zone `views` (1 request per second per client IP, burst 50) on the menu open counter: `/menu/{slug}/views` and `/api/v1/menu/{slug}/views/` (UC-GUEST-004). A full cafe behind one Wi-Fi address still fits; a script cannot write faster than that.
- `client_max_body_size 3m` (the API limits uploads to 2 MB; larger bodies are rejected before Django).
- `add_header X-Robots-Tag "noindex, nofollow"` on `/menu/`.
- HTTP → HTTPS redirect and HSTS.
- `/internal/` answers 404 to the public (§3.5).
- `= /health` goes to Next.js (§3.7), without an access-log line, inside the `/menu/` rate-limit zone.

### Scheduled Jobs

| Job | Frequency | Purpose |
|---|---|---|
| `pg_dump` → `age` → Cloudflare R2 | Daily | Database backup, encrypted for an offline key (30-day retention) |
| `python manage.py flushexpiredtokens` | Daily | Removes expired rows from the JWT outstanding/blacklist tables, which grow with every login and refresh |
| `python manage.py expire_subscriptions` | Daily, 21:10 UTC (00:10 in Damascus) | Deactivates the cafes whose paid time is over (UC-ADMIN-012) |
| `python manage.py prune_menu_views` | Daily | Deletes menu open counters older than 400 days |

### Error Tracking

Optional, with Sentry or GlitchTip (hosted; same SDK): Django uses `sentry-sdk` (`core/error_tracking.py`), the Next.js server `@sentry/nextjs` (`src/instrumentation.ts`, server only: nothing is added to the customer pages). Both start only when `SENTRY_DSN` is set, so development, tests and CI send nothing; `SENTRY_RELEASE` is the image tag.

- Errors only: no performance tracing (`traces_sample_rate = 0`).
- No personal data: no user info, cookies, request headers or bodies, and no local variables of the stack frames; a `before_send` hook also drops `Authorization`, `Cookie`, `X-Revalidate-Secret` and `X-Forwarded-For` before an event leaves the server.
- Without a DSN, errors still reach the container log (Django `LOGGING`, Next.js stderr).

### Docker Services

| Service | Image | Port | Healthcheck |
|---|---|---|---|
| `nginx` | `nginx:alpine` | 80, 443 | — (starts after `backend` and `frontend` are healthy) |
| `backend` | Custom Django image | 8000 (internal) | `GET /api/v1/health/` (§3.7) |
| `frontend` | Custom Next.js image | 3000 (internal) | `GET /health` (§3.7); starts after `backend` is healthy |
| `db` | `postgres:16-alpine` | 5432 (internal) | `pg_isready` |
| `backup` | Custom cron image | — | — |

### CI/CD Pipeline (GitHub Actions)

```
git push → main branch
    └── GitHub Actions Workflow
          ├── Run tests (Django pytest, on PostgreSQL)
          ├── Run checks (manage.py check --deploy, makemigrations --check --dry-run)
          ├── Build Docker images
          ├── SSH into VPS
          ├── docker-compose pull
          ├── docker-compose up -d
          ├── Run DB migrations (python manage.py migrate)
          ├── Create the cache table (python manage.py createcachetable)
          └── Check https://<domain>/health answers 200 (§3.7), else the deploy fails
```

> `createcachetable` creates the table used by Django's `DatabaseCache` (login throttle counters). It is safe to run on every deploy.

---

## 6. Subscription Plan Enforcement

| Feature | Basic | Pro |
|---|---|---|
| Max categories | Limited (e.g., 5) | Unlimited |
| Max items | Limited (e.g., 20) | Unlimited |
| Item images | ❌ | ✅ requires allows_images |
| Custom logo | ❌ | governed by allows_branding |
| Custom primary color | ❌ | governed by allows_branding |
| QR Code PDF export | ✅ | ✅ |
| Analytics: menu opens per day | ✅ | ✅ |
| Analytics: per hour and per table | ❌ | governed by allows_detailed_analytics |
| Change cafe slug | Super Admin only | Super Admin only |

Enforcement is done in the **Service Layer** (`services.py`) before any create/update operation. The API returns `403 Forbidden` with a message like `{"detail": "Your plan does not support item images. Upgrade to Pro."}` when a limit is exceeded.
Enforcement uses the plan flags (`allows_images`, `allows_branding`, `allows_detailed_analytics`, `max_categories`, `max_items`), never the plan name. A flag added after the plans were created is set on the existing rows with `python manage.py create_plans --sync-flags`. Limits count only rows with `deleted_at IS NULL`.
After a downgrade, stored item images, logo and primary color are kept but hidden from customers until the plan allows them again (use_cases.md Global Convention 7). They never block a downgrade; only `max_categories` and `max_items` do (UC-ADMIN-006 A2).

---

## 7. Security Considerations

| Concern | Mitigation |
|---|---|
| Tenant data leakage | `cafe_id` filter on every queryset + a cross-tenant 404 test for every endpoint; PostgreSQL RLS planned post-MVP (§7.1) |
| Cross-tenant access | Resources of another cafe answer 404 (never 403) |
| JWT token theft | Short-lived access tokens (15 min) + refresh token rotation with blacklist after rotation; tokens kept in HttpOnly cookies by the Next.js BFF, never in `localStorage` (§3.6) |
| Image upload abuse | Format checked by content with Pillow (JPEG/PNG/WebP allowlist, max 25 megapixels), max 2 MB, re-encoded to WebP without metadata, random object keys, stored on R2 (not server disk); Nginx `client_max_body_size 3m` |
| Admin impersonation | `role = SYSTEM_ADMIN` required for all `/api/v1/admin/` endpoints |
| Price scraping | `noindex, nofollow` meta tag + `X-Robots-Tag` header on all customer pages |
| SQL injection | Django ORM parameterized queries |
| Login brute force | Nginx `limit_req` + DRF `ScopedRateThrottle` (`login`, 5/min per client IP, `DatabaseCache`, `NUM_PROXIES`) |
| Password reset email abuse | No user enumeration: one answer (`204`) for every well-formed address, and the email is sent in a background thread, so the answer time does not tell either (UC-AUTH-006); only active Cafe Owner accounts get an email, never a Super Admin; at most one email per account per 5 minutes; throttle `password_reset_email` (5/hour per client IP) + Nginx `limit_req`; the email's link is the one-time link of the row below |
| Password reset link theft or reuse | A link is made by a Super Admin (UC-ADMIN-010) or sent to the account's own email address (UC-AUTH-006); the secret part sits after `#`, so it reaches no server log and no `Referer` header; valid 24 hours (`PASSWORD_RESET_TIMEOUT`); one-time, because the token is signed over the password hash; one answer for every invalid link; throttle `password_reset` (5/min per client IP) + Nginx `limit_req`; a reset blacklists every refresh token |
| Customer privacy in analytics | Only counters per cafe, hour and table are stored: no IP address, user agent, cookie or browser storage (UC-GUEST-004); the numbers are shown as approximate |
| Inflated analytics numbers | The counter endpoint is public by design; Nginx limits it to 1 request per second per client IP (zone `views`), and the dashboard labels the numbers as approximate |
| Race conditions on limits and ordering | Cafe row lock (`select_for_update`) inside the service transaction (use_cases.md Global Convention 8) |
| Mass assignment | Serializers list writable fields explicitly; `cafe`, `sort_order`, `deleted_at`, `is_active`, `image_url` and `logo_url` are never writable through general update endpoints |
| Django admin discovery | Admin site served at a non-obvious path (`DJANGO_ADMIN_PATH`), rate limited by Nginx |
| Token table growth | Daily `flushexpiredtokens` |
| Personal data in error reports | Error tracking is off without `SENTRY_DSN`; with it, no user info, cookies, headers, bodies or local variables are sent, and a `before_send` hook drops credentials (§5 Error Tracking) |
| Vulnerable dependencies | Minimum versions above known CVEs (`gunicorn>=23`, `Pillow>=12.3`) |

### 7.1 Row-Level Security

**Status:** designed on 2026-11-12, not built yet (implementation_plan.md step 16). Until it is built, isolation relies on ORM filtering, 404 masking and cross-tenant tests.

Row-Level Security (RLS) is a PostgreSQL feature: a table gets a *policy*, a condition that PostgreSQL adds to every query on that table. It is the second safety layer: PostgreSQL itself hides the rows of other cafes, even if the application forgets a `cafe_id` filter. It guards against our own bugs. It does not guard against an attacker who can run any SQL as the application, because that SQL could also change the settings below.

**Tables.** The six tenant tables, each with a `cafe_id` column: `cafe_tables`, `categories`, `menu_items`, `menu_item_variants`, `billing_events`, `menu_view_counts`. Not `cafes`, `subscription_plans`, `users`, or the JWT and cache tables: the login, the lookup of a cafe by its slug and the lookup of `request.user.cafe` happen before any tenant is known.

**Policy.** One policy per table, the same text for all six, for reads and writes (a policy without `WITH CHECK` uses its `USING` condition for new rows too):

```sql
ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <table> FORCE ROW LEVEL SECURITY;   -- without FORCE the table owner skips the policy
CREATE POLICY tenant_isolation ON <table>
    USING (
        cafe_id = NULLIF(current_setting('app.cafe_id', true), '')::bigint
        OR current_setting('app.rls_bypass', true) = 'on'
    );
```

- `app.cafe_id` and `app.rls_bypass` are two custom settings of the database session. `current_setting(name, true)` answers NULL for a setting that was never set.
- `NULLIF(..., '')`: after a transaction that set `app.cafe_id` ends, PostgreSQL leaves the setting as an empty string, not NULL, on that connection. Without `NULLIF` the next query on the connection would fail with "invalid input syntax for type bigint" instead of seeing no rows.
- Fail closed: with neither setting, the condition is NULL, so no row is visible and every insert, update and delete is refused or touches nothing.
- Foreign key checks and cascades of PostgreSQL itself are not subject to policies.

**Setting the tenant: `core/tenancy.py`.** Two context managers; each opens `transaction.atomic()` and sets both settings with `SELECT set_config(name, value, true)`. The `true` makes the value local to the transaction: it ends with the transaction, so it can never leak to the next request that reuses the connection (connections are kept for 60 seconds, `CONN_MAX_AGE`).

| Scope | Sets | Used by |
|---|---|---|
| `tenant(cafe)` | `app.cafe_id = <cafe id>`, `app.rls_bypass = off` | Every owner service (`request.user.cafe`); the public menu and the menu open counter, after they found the cafe by its slug |
| `all_tenants()` | `app.cafe_id = ''`, `app.rls_bypass = on` | Super Admin services (they read and write any cafe); the nightly commands `expire_subscriptions` and `prune_menu_views`; the QR link lookup (UC-GUEST-003), which finds a table by its `qr_token` before any cafe is known |

Rules that follow from this:

1. The scope is opened in the service layer, never in a view, a serializer or a middleware. JWT authentication runs inside the DRF view, after all middleware, so a middleware does not know the cafe yet. `ATOMIC_REQUESTS` is not used: it would keep a database transaction open during an R2 upload, and it would roll back the login throttle counters (they live in `DatabaseCache`) whenever a request fails.
2. A service returns evaluated data (a list or an object with everything loaded), never a lazy queryset on a tenant table. A queryset that runs later, outside the scope, sees no rows.
3. Scopes are not nested with a different tenant. An inner scope would change the settings for the rest of the outer transaction.
4. Code outside both scopes cannot read or write a tenant table. That is the point: a forgotten scope shows up as an empty answer in the tests, not as a leak in production.

**Database roles.**

| Role | Environment | What it is | Used by |
|---|---|---|---|
| App role | `DB_USER`, `DB_PASSWORD` | Not a superuser, `NOBYPASSRLS`, owns no table; may only SELECT, INSERT, UPDATE and DELETE rows and use sequences | The `backend` service (every web request) |
| Owner role | `DB_MIGRATE_USER`, `DB_MIGRATE_PASSWORD` | Owns the tables; the role the `db` service creates on its first start (a superuser, so policies do not apply to it) | `migrate`, `createcachetable`, the command that creates the app role, and the `backup` service (`pg_dump` and the nightly commands) |

- `pg_dump` refuses to dump a table whose policy would hide rows from it, so the backup must run as the owner role.
- The app role is created once by a management command run as the owner role (`python manage.py create_app_role`): it reads the app role's name and password from the environment, creates or updates the role, and grants the rights above, also for tables that later migrations add (`ALTER DEFAULT PRIVILEGES`). No password is ever written in a migration.
- Local development keeps one role for everything (the superuser of the development database), so policies are not enforced there. CI enforces them (see Tests).

**Migrations.** Django cannot generate policies, so they are `RunSQL` migrations, each started with `makemigrations --empty` and with `reverse_sql` that drops the policy and disables RLS. This is the one approved exception to "never hand-write a migration" (implementation_plan.md). One migration per app: `cafes` (`billing_events` first, then `cafe_tables`), `menu` (`categories`, `menu_items`, `menu_item_variants`), `analytics` (`menu_view_counts`). A new tenant table must get its policy in the migration that creates it.

**Tests.** CI runs the backend tests as a role that is not a superuser. Because of `FORCE`, the policies apply to it although it owns the test tables. Test fixtures are written with the bypass on; during each HTTP request of a test the bypass is off and the tenant is empty, so only the scopes the services open decide what is visible. Dedicated tests prove, for every tenant table: an unfiltered query inside `tenant(cafe)` returns only that cafe's rows; outside any scope it returns none; inserting a row for another cafe is refused. With a superuser (local development) these dedicated tests are skipped.

**Not built:** the composite foreign key (`menu_items (category_id, cafe_id)` → `categories (id, cafe_id)`). The services already check that an item and its category belong to the same cafe, and the policy now hides a category of another cafe from that check.
