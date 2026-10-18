# Implementation Plan — Tartus Smart Digital Menu

## Status: ✅ System Design Complete — Ready for Development

All architectural decisions have been locked in. Below is a summary of every decision made and links to the detailed design documents.

---

## Decisions Made (Full Interview Summary)

| Topic | Decision |
|---|---|
| Architecture | Modular Monolith |
| Backend | Django + Django REST Framework |
| Frontend | Next.js (single app — Route Groups for admin + customer) |
| Database | PostgreSQL — shared schema, `cafe_id` isolation (RLS post-MVP) |
| Auth | JWT via `djangorestframework-simplejwt` — access 15 min, refresh 1 day, rotation + blacklist after rotation; login rate limited (5/min per client IP, `DatabaseCache`); the frontend keeps tokens through a Next.js BFF in HttpOnly cookies |
| Storage | Cloudflare R2 (10GB free, no egress fees, built-in CDN), served from a custom domain |
| Multi-tenancy | Shared tables + `cafe_id` FK on every tenant-owned table; PostgreSQL RLS planned post-MVP (system_design.md §7.1) |
| Localization | Arabic + English, stored as JSONB: `{"ar": "...", "en": "..."}`; `ar` required, `en` optional, display falls back to `ar` |
| Currency | SYP only — hardcoded, no currency field; new SYP after the 2026-01-01 redenomination; display with Western digits, trailing `.00` hidden |
| Menu depth | 2 levels: Category → Items |
| Item fields | name, description (both bilingual), price, image, is_available, is_featured, is_new |
| Delete policy | Soft delete (categories, items) · Hard delete (cafes, billing_events) |
| Reorder algorithm | Gapped Integer (100, 200, 300…) — minimizes DB writes |
| QR Code URL | `/menu/[cafe-slug]?table=N` — the `table` parameter is display-only; tables themselves are persisted (see "Tables") |
| QR PDF | Generated on Django backend using `reportlab` from the persisted active tables (vector QR widget, error correction level Q) |
| Tables | Persisted `CafeTable` (`cafe_id`, `table_number`, `qr_token`, `is_active`); UNIQUE (`cafe_id`, `table_number`); table count derived from active rows; no `table_count` column |
| Slug changes | Super Admin only |
| Billing model | Monthly subscription: Basic / Pro plans |
| Plan enforcement | Enforced in Service Layer (`services.py`) — uses capability flags (`allows_images`, `allows_branding`), returns `403` on violation; after a downgrade, stored images/logo/color are kept and hidden from customers |
| Billing activation | Manual by Super Admin via admin dashboard |
| Inactive cafe behavior | Customer sees "Temporarily Unavailable" page; owner dashboard answers 403 everywhere except GET settings |
| Analytics | **Deferred — not in MVP** |
| Routing | Host `menu.domain.com`; customer page route `/menu/[cafe-slug]` |
| Theming | Logo (Pro) + Primary Color (Pro) injected as CSS variable |
| Caching | Next.js ISR + on-demand revalidation triggered by Django after commit; 5-minute time-based fallback (no Redis in MVP) |
| Image uploads | Pillow validation → resize → metadata removed → WebP; random R2 keys under `cafes/<cafe_id>/` |
| Django admin site | Non-obvious path from env `DJANGO_ADMIN_PATH`, routed by Nginx |
| Empty values | `''` (not NULL) means "none" for `image_url`, `logo_url` and `primary_color` |
| SEO | `noindex, nofollow` on all customer pages |
| Super Admin screens | Stats · Cafe list · Create cafe · Edit cafe/slug · Billing history |
| Cafe Owner screens | Categories · Items · QR Codes · Settings |
| API versioning | `/api/v1/` from day one |
| API errors | Standard DRF format: `{"detail": "..."}` |
| Deployment | Docker Compose on single VPS (under $20/month) |
| Reverse proxy | Nginx + Let's Encrypt (Certbot) |
| CI/CD | GitHub Actions → SSH → `docker-compose up -d` → migrate |
| DB Backups | Daily `pg_dump` → Cloudflare R2 (30-day retention) |

---

## Design Documents

### 1. System Design Document
Full database schema (ERD), API contract with request/response examples, user flows for all 3 actors, and security considerations.
→ [system_design.md](system_design.md)

### 2. ERD Diagram (Interactive)
Visual entity-relationship diagram showing all 7 tables, their columns, data types, badges (PK/FK/U), relationships, and delete policies.
→ [erd_diagram.html](erd_diagram.html)

### 3. Deployment Architecture (Interactive)
Docker Compose service stack, Nginx routing rules, GitHub Actions CI/CD pipeline, and backup strategy diagram.
→ [deployment_architecture.html](deployment_architecture.html)

### 4. Best Practices Research (advisory — NOT a source of truth)
Comparison with similar systems, suggestions and the skills needed. Decisions taken from it are recorded in the documents above.
→ [best_practices_research.md](best_practices_research.md)

---

## Next Steps (In Order)

1. **[ ] Review & approve this system design** — confirm all decisions above are correct before writing any code.
2. **[ ] Set up project directory** — create `tartus_menu/backend` and `tartus_menu/frontend` scaffold.
3. **[ ] Backend bootstrapping** — Django project setup, apps, models, migrations.
4. **[ ] Auth layer** — JWT login, Super Admin and Cafe Owner permission classes, login rate limit.
5. **[ ] Core API** — Categories, Items, Cafe Settings endpoints.
6. **[ ] Cloudflare R2 integration** — `django-storages` + `boto3`; Pillow upload pipeline (WebP, random keys, custom domain).
7. **[ ] QR Code + PDF generation** — `qrcode` + `reportlab`.
8. **[ ] Frontend bootstrapping** — Next.js app, Route Groups, Tailwind, i18n, BFF auth routes.
9. **[ ] Customer menu page** — ISR + on-demand revalidation endpoint, theming, PWA config, `noindex` meta.
10. **[ ] Admin dashboard UI** — Categories, Items, QR, Settings screens.
11. **[ ] Super Admin dashboard UI** — Cafe management screens.
12. **[ ] Docker Compose** — All services, Nginx config (admin path, rate limits, `/internal/` block, body size), environment variables.
13. **[ ] GitHub Actions CI/CD** — Workflow file, SSH secrets.
14. **[ ] DB backup cron** — Docker service for daily `pg_dump` → R2, plus daily `flushexpiredtokens`.
15. **[ ] End-to-end testing** — Full flow from login to QR scan.
16. **[ ] Post-MVP: PostgreSQL RLS** — Second isolation layer (system_design.md §7.1).
