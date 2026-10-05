# System Design — Tartus Smart Digital Menu

## 1. Decisions Summary

| Topic | Decision |
|---|---|
| Architecture | Modular Monolith |
| Backend | Django + DRF |
| Frontend | Next.js (single app, Route Groups) |
| Database | PostgreSQL (shared schema, `cafe_id` isolation) |
| Auth | JWT via `simplejwt` |
| Storage | Cloudflare R2 |
| Multi-tenancy | Shared tables + RLS + `cafe_id` FK |
| Languages | Arabic + English (JSONB fields) |
| Currency | SYP only (hardcoded) |
| Menu levels | 2 levels: Category → Item |
| QR URL | `/menu/[cafe-slug]?table=N` |
| QR PDF | Django (`reportlab`) |
| Billing | Manual activation by Super Admin |
| Analytics | Deferred — not in MVP |
| Reverse Proxy | Nginx + Let's Encrypt |
| Deployment | Docker Compose on VPS |
| CI/CD | GitHub Actions → SSH → restart containers |
| DB Backups | Daily `pg_dump` → Cloudflare R2 |
| API versioning | `/api/v1/` |
| API errors | Standard DRF format |

---

## 2. Database Schema (ERD)

### 2.1 Users & Auth

```
users (Django default auth_user)
├── id (PK)
├── email
├── password (hashed)
├── is_staff (True = Super Admin)
└── is_active
```

### 2.2 Core Tables

```
subscription_plans
├── id (PK)
├── name          VARCHAR(50)   -- 'basic' | 'pro'
├── max_categories INT          -- NULL = unlimited
└── max_items      INT          -- NULL = unlimited
```

```
cafes
├── id              PK
├── owner_id        FK → auth_user.id (OneToOne)
├── plan_id         FK → subscription_plans.id
├── slug            VARCHAR(100) UNIQUE
├── name            JSONB        -- {"ar":"...", "en":"..."}
├── primary_color   VARCHAR(7)   -- hex e.g. "#FF5733"
├── logo_url        TEXT         -- Cloudflare R2 URL
├── is_active       BOOLEAN      DEFAULT false
├── subscription_start_at  TIMESTAMPTZ NULL
├── subscription_end_at    TIMESTAMPTZ NULL
├── created_at      TIMESTAMPTZ  DEFAULT now()
└── updated_at      TIMESTAMPTZ  DEFAULT now()
```

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
├── price         NUMERIC(10,2)
├── image_url     TEXT         -- Cloudflare R2 URL (NULL if Basic plan)
├── is_available  BOOLEAN      DEFAULT true
├── is_featured   BOOLEAN      DEFAULT false
├── is_new        BOOLEAN      DEFAULT false
├── sort_order    INT          -- Gapped: 100, 200, 300
├── deleted_at    TIMESTAMPTZ  NULL  -- Soft delete
├── created_at    TIMESTAMPTZ  DEFAULT now()
└── updated_at    TIMESTAMPTZ  DEFAULT now()
```

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
| `categories` | **Soft delete** (`deleted_at`) | `cafe_id` |
| `menu_items` | **Soft delete** (`deleted_at`) | `cafe_id` |
| `billing_events` | Hard delete (audit log, not user-facing) | `cafe_id` |

---

## 3. API Contract — `/api/v1/`

### 3.1 Auth

| Method | Endpoint | Actor | Description |
|---|---|---|---|
| POST | `/api/v1/auth/login/` | Any | Obtain JWT access + refresh tokens |
| POST | `/api/v1/auth/refresh/` | Any | Refresh access token |
| POST | `/api/v1/auth/logout/` | Any | Blacklist refresh token |

**Login Request:**
```json
{ "email": "owner@cafe.com", "password": "secret" }
```
**Login Response:**
```json
{
  "access": "<jwt_access_token>",
  "refresh": "<jwt_refresh_token>",
  "role": "cafe_owner"
}
```

---

### 3.2 Super Admin — Cafes Management

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/admin/cafes/` | List all cafes (paginated) |
| POST | `/api/v1/admin/cafes/` | Create a new cafe + owner account |
| GET | `/api/v1/admin/cafes/{id}/` | Get cafe details |
| PATCH | `/api/v1/admin/cafes/{id}/` | Update cafe details / plan |
| DELETE | `/api/v1/admin/cafes/{id}/` | Hard delete a cafe |
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
| POST | `/api/v1/dashboard/qr/generate/` | Set table count, generate QR URLs |
| GET | `/api/v1/dashboard/qr/preview/` | List all QR codes for the cafe |
| GET | `/api/v1/dashboard/qr/download-pdf/` | Download print-ready PDF (reportlab) |

**Generate QR Request:**
```json
{ "table_count": 12 }
```

**Generate QR Response:**
```json
{
  "tables": [
    { "table_number": 1, "url": "https://menu.domain.com/tartus-coffee?table=1", "qr_image_url": "..." },
    { "table_number": 2, "url": "https://menu.domain.com/tartus-coffee?table=2", "qr_image_url": "..." }
  ]
}
```

#### Cafe Settings

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/v1/dashboard/settings/` | Get cafe profile |
| PATCH | `/api/v1/dashboard/settings/` | Update name, slug, primary_color |
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
    "logo_url": "https://r2.domain.com/logos/tartus-coffee.png",
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
          "price": "5000",
          "image_url": "https://r2.domain.com/items/espresso.jpg",
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
              ├── Update Slug
              ├── Change Primary Color
              └── Upload Logo
```

### 4.3 Customer Flow
```
Scan QR Code
  └── GET /menu/[slug]?table=3
        ├── If active → Show Menu
        │     ├── Switch Language (ar/en)
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
    ├── /api/*          → Django (Gunicorn, port 8000)
    │                        └── PostgreSQL (port 5432)
    │
    └── /*              → Next.js (port 3000)
                              └── Cloudflare R2 (image CDN)

All services run inside Docker Compose on a single VPS.
```

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
          ├── Run tests (Django pytest)
          ├── Build Docker images
          ├── SSH into VPS
          ├── docker-compose pull
          ├── docker-compose up -d
          └── Run DB migrations (python manage.py migrate)
```

---

## 6. Subscription Plan Enforcement

| Feature | Basic | Pro |
|---|---|---|
| Max categories | Limited (e.g., 5) | Unlimited |
| Max items | Limited (e.g., 20) | Unlimited |
| Item images | ❌ | ✅ |
| Custom logo | ❌ | ✅ |
| Custom primary color | ❌ | ✅ |
| QR Code PDF export | ✅ | ✅ |

Enforcement is done in the **Service Layer** (`services.py`) before any create/update operation. The API returns `403 Forbidden` with a message like `{"detail": "Your plan does not support item images. Upgrade to Pro."}` when a limit is exceeded.

---

## 7. Security Considerations

| Concern | Mitigation |
|---|---|
| Tenant data leakage | `cafe_id` filter on every queryset + PostgreSQL RLS |
| JWT token theft | Short-lived access tokens (15 min) + refresh token rotation |
| Image upload abuse | File type validation (MIME), max size limit (2MB), store on R2 (not server disk) |
| Admin impersonation | `is_staff` flag on `auth_user` required for all `/admin/` endpoints |
| Price scraping | `noindex, nofollow` meta tag on all customer pages |
| SQL injection | Django ORM parameterized queries |
