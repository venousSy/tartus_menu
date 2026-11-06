# Tartus Smart Digital Menu (MVP)

A multi-tenant electronic menu platform designed for local cafes in Tartus, Syria.

Status: the MVP is built (every step of `docs/implementation_plan.md`); it is not deployed to a server yet.

## Project Structure Overview

```text
tartus_menu/
├── docs/                             # System design and architecture specifications
│   ├── use_cases.md                  # Behavior of every feature: flows, errors, status codes
│   ├── system_design.md              # Full database schema, API contracts, user flows
│   ├── implementation_plan.md        # Technical decisions roadmap and verification plan
│   ├── code_overview.md              # Learning guide to the backend code
│   ├── erd_diagram.html              # Interactive ERD diagram
│   └── deployment_architecture.html  # Visual Docker Compose & CI/CD deployment architecture
├── backend/                          # Django + Django REST Framework (apps: users, cafes, menu)
├── frontend/                         # Next.js: customer menu (PWA), owner dashboard, Super Admin pages
├── deploy/                           # Runbook for the VPS and the Nginx configuration
├── compose.yaml                      # The production stack (PostgreSQL, Django, backups, Next.js, Nginx)
├── .github/workflows/ci-cd.yml       # Tests, audits, images, end-to-end tests, deploy
└── OBSERVATIONS.md                   # Backlog of known problems
```

## Getting Started

| To | Read |
|---|---|
| Run the backend locally | `backend/.env.example` (copy to `backend/.env`), then `python manage.py migrate` and `runserver` from `backend/` |
| Run the frontend locally | `frontend/README.md` |
| Run the end-to-end tests | `frontend/e2e/README.md` |
| Deploy to a VPS | `deploy/README.md` |

## Key Technical Decisions

- **Architecture:** Modular Monolith
- **Backend:** Django + DRF, Service Layer pattern
- **Frontend:** Next.js (App Router, Route Groups for Admin & Customer views), PWA with offline caching
- **Database:** PostgreSQL with shared schema, multi-tenancy enforced via `cafe_id` filtering (PostgreSQL Row-Level Security planned post-MVP)
- **Authentication:** JWT via `djangorestframework-simplejwt`; the Next.js server (BFF) keeps the tokens in HttpOnly cookies
- **Storage:** Cloudflare R2 (S3-compatible, no egress fees)
- **Menu Features:** 2-level hierarchy (Category → Item), bilingual (Arabic & English via JSONB), static QR codes per table with print-ready PDF export via `reportlab`
- **Deployment:** Docker Compose on a single VPS (<$20/mo), Nginx reverse proxy with Let's Encrypt SSL, automated daily backups to R2

## Documentation Links

- [Use Cases](docs/use_cases.md)
- [System Design Document](docs/system_design.md)
- [Implementation Plan](docs/implementation_plan.md)
- [Interactive ERD Diagram](docs/erd_diagram.html)
- [Deployment Architecture Diagram](docs/deployment_architecture.html)
- [Code Overview (learning guide)](docs/code_overview.md)
