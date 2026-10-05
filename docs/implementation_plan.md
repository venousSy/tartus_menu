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
| Database | PostgreSQL — shared schema, `cafe_id` isolation + RLS |
| Auth | JWT via `djangorestframework-simplejwt` |
| Storage | Cloudflare R2 (10GB free, no egress fees, built-in CDN) |
| Multi-tenancy | Shared tables + `cafe_id` FK on every tenant-owned table |
| Localization | Arabic + English, stored as JSONB: `{"ar": "...", "en": "..."}` |
| Currency | SYP only — hardcoded, no currency field |
| Menu depth | 2 levels: Category → Items |
| Item fields | name, description (both bilingual), price, image, is_available, is_featured, is_new |
| Delete policy | Soft delete (categories, items) · Hard delete (cafes, billing_events) |
| Reorder algorithm | Gapped Integer (100, 200, 300…) — minimizes DB writes |
| QR Code URL | `/menu/[cafe-slug]?table=N` — table number is display-only, not a DB entity |
| QR PDF | Generated on Django backend using `reportlab` |
| Billing model | Monthly subscription: Basic / Pro plans |
| Plan enforcement | Enforced in Service Layer (`services.py`) — returns `403` on violation |
| Billing activation | Manual by Super Admin via admin dashboard |
| Inactive cafe behavior | Customer sees "Temporarily Unavailable" page |
| Analytics | **Deferred — not in MVP** |
| Routing | Path-based: `menu.domain.com/[cafe-slug]` |
| Theming | Logo (Pro) + Primary Color (Pro) injected as CSS variable |
| Caching | Next.js ISR (no Redis in MVP) |
| SEO | `noindex, nofollow` on all customer pages |
| Super Admin screens | Stats · Cafe list · Create cafe · Edit cafe · Billing history · Analytics per cafe |
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
→ [system_design.md](file:///C:/Users/alisy/.gemini/antigravity/brain/db1a109d-fa2c-4ae0-823b-c86fd7876a33/system_design.md)

### 2. ERD Diagram (Interactive)
Visual entity-relationship diagram showing all 6 tables, their columns, data types, badges (PK/FK/U), relationships, and delete policies.
→ [erd_diagram.html](file:///C:/Users/alisy/.gemini/antigravity/brain/db1a109d-fa2c-4ae0-823b-c86fd7876a33/erd_diagram.html)

### 3. Deployment Architecture (Interactive)
Docker Compose service stack, Nginx routing rules, GitHub Actions CI/CD pipeline, and backup strategy diagram.
→ [deployment_architecture.html](file:///C:/Users/alisy/.gemini/antigravity/brain/db1a109d-fa2c-4ae0-823b-c86fd7876a33/deployment_architecture.html)

---

## Next Steps (In Order)

1. **[ ] Review & approve this system design** — confirm all decisions above are correct before writing any code.
2. **[ ] Set up project directory** — create `tartus_menu/backend` and `tartus_menu/frontend` scaffold.
3. **[ ] Backend bootstrapping** — Django project setup, apps, models, migrations.
4. **[ ] Auth layer** — JWT login, Super Admin and Cafe Owner permission classes.
5. **[ ] Core API** — Categories, Items, Cafe Settings endpoints.
6. **[ ] Cloudflare R2 integration** — `django-storages` + `boto3`.
7. **[ ] QR Code + PDF generation** — `qrcode` + `reportlab`.
8. **[ ] Frontend bootstrapping** — Next.js app, Route Groups, Tailwind, i18n.
9. **[ ] Customer menu page** — ISR, theming, PWA config, `noindex` meta.
10. **[ ] Admin dashboard UI** — Categories, Items, QR, Settings screens.
11. **[ ] Super Admin dashboard UI** — Cafe management screens.
12. **[ ] Docker Compose** — All services, Nginx config, environment variables.
13. **[ ] GitHub Actions CI/CD** — Workflow file, SSH secrets.
14. **[ ] DB backup cron** — Docker service for daily `pg_dump` → R2.
15. **[ ] End-to-end testing** — Full flow from login to QR scan.
