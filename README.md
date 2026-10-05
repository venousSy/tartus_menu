# Tartus Smart Digital Menu (MVP)

A multi-tenant electronic menu platform designed for local cafes in Tartus, Syria.

## Project Structure Overview

```text
tartus_menu/
├── docs/                             # System design and architecture specifications
│   ├── system_design.md              # Full database schema, API contracts, user flows
│   ├── implementation_plan.md        # Technical decisions roadmap and verification plan
│   ├── erd_diagram.html              # Interactive ERD diagram
│   └── deployment_architecture.html  # Visual Docker Compose & CI/CD deployment architecture
├── backend/                          # Django + Django REST Framework (Upcoming)
└── frontend/                         # Next.js App Router (Upcoming)
```

## Key Technical Decisions

- **Architecture:** Modular Monolith
- **Backend:** Django + DRF, Service Layer pattern
- **Frontend:** Next.js (App Router, Route Groups for Admin & Customer views), PWA with offline caching
- **Database:** PostgreSQL with shared schema, multi-tenancy enforced via `cafe_id` + Row-Level Security (RLS)
- **Authentication:** JWT via `djangorestframework-simplejwt`
- **Storage:** Cloudflare R2 (S3-compatible, no egress fees)
- **Menu Features:** 2-level hierarchy (Category → Item), bilingual (Arabic & English via JSONB), static QR codes per table with print-ready PDF export via `reportlab`
- **Deployment:** Docker Compose on a single VPS (<$20/mo), Nginx reverse proxy with Let's Encrypt SSL, automated daily backups to R2

## Documentation Links

- [System Design Document](docs/system_design.md)
- [Implementation Plan](docs/implementation_plan.md)
- [Interactive ERD Diagram](docs/erd_diagram.html)
- [Deployment Architecture Diagram](docs/deployment_architecture.html)
