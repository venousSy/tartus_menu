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
| QR URL | `/menu/[cafe-slug]?table=N` |
| QR PDF | Django (`reportlab`, vector QR widget); preview images with the `qrcode` library; error correction level Q, 4-module quiet zone |
| Tables | Persisted `CafeTable` per physical table (unique `table_number` per cafe + `qr_token`); table count is derived from active rows, no `table_count` column |
| Slug changes | Super Admin only |
| Billing | Manual activation by Super Admin |
| Analytics | Deferred — not in MVP |
| Reverse Proxy | Nginx + Let's Encrypt |
| Deployment | Docker Compose on VPS |
| CI/CD | GitHub Actions → SSH → restart containers |
| DB Backups | Daily `pg_dump` → Cloudflare R2 |
| API versioning | `/api/v1/` |
| API errors | Standard DRF format |
| Public menu caching | Next.js ISR + on-demand revalidation called by Django after commit (§3.5); 5-minute time-based fallback |
| Frontend auth | BFF: Next.js server routes keep the JWT pair in HttpOnly cookies; single-flight refresh (§3.6) |
| Rate limiting | Nginx `limit_req` on login paths + DRF `ScopedRateThrottle` (scope `login`, 5/min per client IP) stored in Django `DatabaseCache` (no Redis) |
| Image uploads | Validated by content with Pillow, resized, metadata removed, stored as WebP under random keys (`cafes/<cafe_id>/...`), served from the R2 custom domain |
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
└── allows_branding  BOOLEAN       -- logo + primary color
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
├── subscription_end_at    TIMESTAMPTZ NULL
├── created_at      TIMESTAMPTZ  DEFAULT now()
└── updated_at      TIMESTAMPTZ  DEFAULT now()
```

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
├── is_available  BOOLEAN      DEFAULT true
├── is_featured   BOOLEAN      DEFAULT false
├── is_new        BOOLEAN      DEFAULT false
├── sort_order    INT          -- Gapped: 100, 200, 300
├── deleted_at    TIMESTAMPTZ  NULL  -- Soft delete
├── created_at    TIMESTAMPTZ  DEFAULT now()
└── updated_at    TIMESTAMPTZ  DEFAULT now()
```

> JSONB text fields (`name`, `description`) follow use_cases.md Global Convention 6: in `name`, `ar` is required and non-empty and `en` is optional; no other keys are allowed. String fields that can be "none" (`image_url`, `logo_url`, `primary_color`) use `''`, never NULL.

```
billing_events
├── id          PK
├── cafe_id     FK → cafes.id
├── action      VARCHAR(20)  -- 'activated' | 'deactivated' | 'plan_changed'
├── notes       TEXT
├── performed_by_id  FK → auth_user.id
└── created_at  TIMESTAMPTZ  DEFAULT now()
```

### 2.3 Delete & Isolation Policies

| Table | Delete Policy | Isolation |
|---|---|---|
| `cafes` | Hard delete (cascades) | `owner_id` |
| `cafe_tables` | Deactivate (`is_active = false`); rows are removed only by the cafe CASCADE | `cafe_id` |
| `categories` | **Soft delete** (`deleted_at`) | `cafe_id` |
| `menu_items` | **Soft delete** (`deleted_at`) | `cafe_id` |
| `billing_events` | Hard delete (audit log, not user-facing) | `cafe_id` |

---

## 3. API Contract — `/api/v1/`

### 3.1 Auth

| Method | Endpoint | Actor | Description |
|---|---|---|---|
| POST | `/api/v1/auth/login/` | Any | Obtain JWT access + refresh tokens |
| POST | `/api/v1/auth/refresh/` | Any | Exchange refresh token for a new access + refresh pair (old refresh is blacklisted) |
| POST | `/api/v1/auth/logout/` | Any | Blacklist refresh token |
| POST | `/api/v1/auth/change-password/` | Any | Change own password; blacklists all outstanding refresh tokens |

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
| GET | `/api/v1/admin/cafes/{id}/billing/` | Get billing history |
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
| POST | `/api/v1/dashboard/items/` | Create item |
| PATCH | `/api/v1/dashboard/items/{id}/` | Update item |
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
    { "id": 1, "table_number": 1, "url": "https://menu.domain.com/menu/tartus-coffee?table=1", "qr_token": "<uuid4>", "qr_image_url": "data:image/png;base64,..." },
    { "id": 2, "table_number": 2, "url": "https://menu.domain.com/menu/tartus-coffee?table=2", "qr_token": "<uuid4>", "qr_image_url": "data:image/png;base64,..." }
  ]
}
```

`qr_token` is stored and returned but is not part of the URL in the MVP.

#### Cafe Settings

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/dashboard/settings/` | Get cafe profile + plan flags + is_active (answers 200 even when inactive) |
| PATCH | `/api/v1/dashboard/settings/` | Update name, primary_color (slug is Super Admin only) |
| POST | `/api/v1/dashboard/settings/logo/` | Upload logo → R2 |

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
          "is_available": true,
          "is_featured": true,
          "is_new": false,
          "sort_order": 100
        }
      ]
    }
  ]
}
```

> When `is_active` is `false`, the API still returns 200 with `is_active: false` so the frontend can display the "Temporarily Unavailable" screen.

> Plan-gated values are hidden in this response (use_cases.md Global Convention 7): `image_url` is `""` while the plan has `allows_images = false`; `logo_url` and `primary_color` are `""` while it has `allows_branding = false`. `price` is a string with two decimals in new SYP (Global Convention 10).

> This endpoint is called by the Next.js server (ISR), not by the customer's browser. It is therefore not rate limited per client IP in DRF; Nginx rate-limits the `/menu/` pages instead.

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
    │
    └── /*                     → Next.js (port 3000)
                                    └── Cloudflare R2 (image CDN, custom domain)

All services run inside Docker Compose on a single VPS.
```

### Nginx Rules

- Every proxied location sets `X-Forwarded-For $proxy_add_x_forwarded_for` and `X-Forwarded-Proto`.
- `limit_req` (per client IP) on `/api/v1/auth/login/`, the BFF login route and the Django admin login page.
- `client_max_body_size 3m` (the API limits uploads to 2 MB; larger bodies are rejected before Django).
- `add_header X-Robots-Tag "noindex, nofollow"` on `/menu/`.
- HTTP → HTTPS redirect and HSTS.
- `/internal/` answers 404 to the public (§3.5).

### Scheduled Jobs

| Job | Frequency | Purpose |
|---|---|---|
| `pg_dump` → Cloudflare R2 | Daily | Database backup (30-day retention) |
| `python manage.py flushexpiredtokens` | Daily | Removes expired rows from the JWT outstanding/blacklist tables, which grow with every login and refresh |

### Docker Services

| Service | Image | Port |
|---|---|---|
| `nginx` | `nginx:alpine` | 80, 443 |
| `backend` | Custom Django image | 8000 (internal) |
| `frontend` | Custom Next.js image | 3000 (internal) |
| `db` | `postgres:16-alpine` | 5432 (internal) |
| `backup` | Custom cron image | — |

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
          └── Create the cache table (python manage.py createcachetable)
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
| Change cafe slug | Super Admin only | Super Admin only |

Enforcement is done in the **Service Layer** (`services.py`) before any create/update operation. The API returns `403 Forbidden` with a message like `{"detail": "Your plan does not support item images. Upgrade to Pro."}` when a limit is exceeded.
Enforcement uses the plan flags (`allows_images`, `allows_branding`, `max_categories`, `max_items`), never the plan name. Limits count only rows with `deleted_at IS NULL`.
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
| Race conditions on limits and ordering | Cafe row lock (`select_for_update`) inside the service transaction (use_cases.md Global Convention 8) |
| Mass assignment | Serializers list writable fields explicitly; `cafe`, `sort_order`, `deleted_at`, `is_active`, `image_url` and `logo_url` are never writable through general update endpoints |
| Django admin discovery | Admin site served at a non-obvious path (`DJANGO_ADMIN_PATH`), rate limited by Nginx |
| Token table growth | Daily `flushexpiredtokens` |
| Vulnerable dependencies | Minimum versions above known CVEs (`gunicorn>=23`, `Pillow>=12.3`) |

### 7.1 Row-Level Security (post-MVP plan)

**Status:** not part of the MVP. MVP isolation relies on ORM filtering, 404 masking and cross-tenant tests. RLS is the planned second safety layer: PostgreSQL itself hides rows of other cafes, even if the application forgets a filter. Design notes for when it is built:

1. Enable **and force** row-level security on every tenant table (`cafe_tables`, `categories`, `menu_items`, `billing_events`). Without `FORCE ROW LEVEL SECURITY`, the table owner skips the policies.
2. Policies compare `cafe_id` with `current_setting('app.cafe_id', true)::bigint`. When the setting is missing, no rows are visible (fail closed).
3. The tenant is set per transaction with `SELECT set_config('app.cafe_id', %s, true)`. A session-wide value could leak to the next request that reuses the same database connection.
4. JWT authentication runs inside DRF views, after all Django middleware, so the tenant cannot be set in middleware. It must be set after DRF authentication (for example in one shared step at the start of each dashboard view or service), inside `transaction.atomic()`.
5. The public menu (no user) and the Super Admin endpoints (all cafes) need their own policy or database role.
6. The application database role is not a superuser, has no `BYPASSRLS` and does not own the tables. Migrations run with a separate owner role.
7. Optional: a composite foreign key (`menu_items (category_id, cafe_id)` → `categories (id, cafe_id)`) so PostgreSQL itself guarantees that an item and its category belong to the same cafe.
