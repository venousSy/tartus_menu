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
| QR Code URL | The code holds the table's permanent short link `/t/[qr_token]`, which redirects (302) to `/menu/[cafe-slug]?table=N`, so printed codes survive a slug change; the `table` parameter is display-only; tables themselves are persisted (see "Tables") |
| QR PDF | Generated on Django backend using `reportlab` from the persisted active tables (vector QR widget, error correction level Q) |
| Tables | Persisted `CafeTable` (`cafe_id`, `table_number`, `qr_token`, `is_active`); UNIQUE (`cafe_id`, `table_number`); table count derived from active rows; no `table_count` column |
| Slug changes | Super Admin only |
| Billing model | Monthly subscription: Basic / Pro plans |
| Plan enforcement | Enforced in Service Layer (`services.py`) — uses capability flags (`allows_images`, `allows_branding`), returns `403` on violation; after a downgrade, stored images/logo/color are kept and hidden from customers |
| Billing activation | Manual by Super Admin via admin dashboard |
| Inactive cafe behavior | Customer sees "Temporarily Unavailable" page; owner dashboard answers 403 everywhere except GET settings |
| Analytics | Not in the MVP. Planned post-MVP (post_mvp_roadmap.md Phase 3): menu opens per day/hour and per table, no cookies or personal data; Basic sees a summary, Pro the detail (plan flag `allows_detailed_analytics`) |
| Business time zone | `Asia/Damascus` for analytics days/hours and subscription dates; the database and Django `TIME_ZONE` stay UTC |
| Monitoring (post-MVP) | Health URL `/health` + an external uptime check; error tracking with Sentry or GlitchTip (`sentry-sdk`, `@sentry/nextjs`; active only when a DSN is set) |
| Password recovery (post-MVP) | A one-time reset link made by the Super Admin (valid 24 hours, sent by hand); self-service email later |
| Subscription expiry (post-MVP) | A paid-until date (`subscription_expires_on`, required at activation, moved by "Renew"); a nightly job deactivates expired cafes; a warning 7 days before for the owner and the admin |
| Approved dependencies (post-MVP) | `sentry-sdk`, `@sentry/nextjs`, psycopg 3 — each added in its own step |
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

### 5. Post-MVP Roadmap (proposal — NOT a source of truth)
The features and improvements after the MVP, in phases, with the owner's decisions. Each phase changes the documents above in its own docs turns before any code.
→ [post_mvp_roadmap.md](post_mvp_roadmap.md)

---

## Next Steps (In Order)

1. **[x] Review & approve this system design** — confirm all decisions above are correct before writing any code.
2. **[x] Set up project directory** — create `tartus_menu/backend` and `tartus_menu/frontend` scaffold.
3. **[x] Backend bootstrapping** — Django project setup, apps, models, migrations.
4. **[x] Auth layer** — JWT login, Super Admin and Cafe Owner permission classes, login rate limit.
5. **[x] Core API** — Categories, Items, Cafe Settings endpoints.
6. **[x] Cloudflare R2 integration** — `django-storages` + `boto3`; Pillow upload pipeline (WebP, random keys, custom domain).
7. **[x] QR Code + PDF generation** — `qrcode` + `reportlab`.
8. **[x] Frontend bootstrapping** — Next.js app, Route Groups, Tailwind, i18n, BFF auth routes.
9. **[x] Customer menu page** — ISR + on-demand revalidation endpoint, theming, PWA config, `noindex` meta.
10. **[x] Admin dashboard UI** — Categories, Items, QR, Settings screens.
11. **[x] Super Admin dashboard UI** — Cafe management screens.
12. **[x] Docker Compose** — All services, Nginx config (admin path, rate limits, `/internal/` block, body size), environment variables.
13. **[x] GitHub Actions CI/CD** — Workflow file, SSH secrets.
14. **[x] DB backup cron** — Docker service for daily `pg_dump` → R2, plus daily `flushexpiredtokens`.
15. **[x] End-to-end testing** — Full flow from login to QR scan.
16. **[ ] Post-MVP: PostgreSQL RLS** — Second isolation layer (system_design.md §7.1). Done last, after step 27 (post_mvp_roadmap.md item K).

Post-MVP steps (details in [post_mvp_roadmap.md](post_mvp_roadmap.md); each starts with its own docs turns):

17. **[x] Health URL and uptime monitoring** (roadmap C) — system_design.md §3.7.
18. **[x] Stable QR links `/t/<qr_token>`** (roadmap A) — use_cases.md UC-GUEST-003.
19. **[x] Error tracking** — Sentry or GlitchTip (roadmap D); system_design.md §5 "Error Tracking".
20. **[x] Password reset link made by the Super Admin** (roadmap E1) — use_cases.md UC-ADMIN-010, UC-AUTH-005.
21. **[x] Subscription expiry and warnings** (roadmap F) — use_cases.md Global Convention 5, UC-ADMIN-011, UC-ADMIN-012.
22. **[ ] Analytics** (roadmap B).
23. **[ ] Item tags** (roadmap G).
24. **[ ] Item variants (sizes with prices)** (roadmap H).
25. **[ ] Password reset by email** (roadmap E2).
26. **[ ] psycopg 3 and persistent connections** (roadmap I).
27. **[ ] Images: remaining sizes, optional** (roadmap J).
