# Tekpro Document Portal

Secure, multi-tenant document distribution portal for **Tekkonnectpro IT Services (Tekpro)**.
Tekpro staff upload documents to **Amazon Lightsail Object Storage**; customer users
(initially **Antrix**) sign in to browse and download the documents they are authorised to see.

- File contents live in a **private** Lightsail bucket. Browsers upload and download directly
  to/from storage with **short-lived pre-signed URLs**; bytes never pass through the API server.
- Users, customers, folders, permissions, document metadata and the audit trail live in **PostgreSQL**.
- Every operation is authorised **on the server**: role, customer assignment, folder permission
  and document state are re-checked on every request.

## Features

| Area | What is implemented |
|---|---|
| Roles | Tekpro Super Admin, designated Tekpro User (assigned customers only), Customer Admin (download-only, whole organisation), Customer User (download-only, granted folders) |
| Tenancy | Customer-scoped data model with database-level composite foreign keys that make cross-customer folder/document/permission links impossible |
| Authentication | Email + password (Argon2id), HttpOnly SameSite=Strict session cookie, DB-backed sessions with idle + absolute expiry, session rotation, CSRF token, account lockout, rate limiting, password reset and invitation links, one-time Super Admin bootstrap CLI |
| Folders | Nested folders, breadcrumbs, rename, move (cycle-safe, same customer only), recursive delete with typed confirmation, per-folder customer visibility, document counts |
| Permissions | Per-user folder grants for Customer Users: `DOWNLOAD`, `VIEW`, `NONE`, inherited downward; explicit `NONE` can never be overridden |
| Uploads | Direct browser-to-storage uploads, multipart for large files (parallel parts, retries, cancel), server-side verification of existence, exact size and content signature before a document becomes available |
| Downloads | Authorisation chain then a 5-minute (configurable) pre-signed URL that forces `Content-Disposition: attachment`; "link issued" is audited (completion is not claimed) |
| Documents | Search, type/date/folder filters, sorting, server-side pagination, rename, move, soft delete with retention, restore, purge job |
| Audit | Append-only audit log (enforced by a DB trigger) covering logins, user/customer/assignment/permission changes, uploads, downloads, document and folder changes, denied access, settings changes |
| Operations | Health/readiness endpoints, structured JSON logs with secret redaction, storage diagnostics CLI, maintenance jobs (expire uploads, purge, prune), storage/DB reconciliation |
| UI | React SPA: login, password reset, role-specific dashboards, customer/user/assignment management, document explorer, uploads with progress, audit log, storage statistics, system settings; responsive and keyboard accessible |

## Repository layout

```
tekpro-document-portal/
├── backend/                 Node.js + Express + TypeScript API
│   ├── prisma/              schema.prisma and SQL migrations
│   ├── src/
│   │   ├── app.ts           Express app factory (middleware, routes)
│   │   ├── server.ts        process entry point
│   │   ├── config/          environment validation, logger
│   │   ├── middleware/      session/auth, CSRF, rate limits, error handler
│   │   ├── modules/         auth, users, customers (+assignments), folders, documents
│   │   │                    (+downloads), uploads, permissions (AccessPolicy), audit,
│   │   │                    settings, stats, health, mail
│   │   ├── storage/         StorageAdapter, S3/Lightsail adapter, in-memory test adapter
│   │   ├── jobs/            upload expiry, purge, reconciliation, job lock, scheduler
│   │   └── cli/             bootstrap Super Admin, storage check, run jobs
│   └── tests/               unit, integration, security, storage (real S3) suites
├── frontend/                React + Vite + TypeScript SPA
│   ├── src/                 components, layouts, pages, features/explorer, hooks, services
│   └── tests/               React Testing Library suites
├── tests/e2e/               browser smoke test (Playwright) for a running deployment
├── deploy/                  systemd units, nginx config, bucket CORS example
├── docs/                    PRD, architecture, API, security, deployment, backup, testing
└── .env.example             all server configuration keys
```

## Technology stack

Node.js 22 · TypeScript 5.9 · Express 5 · Zod 4 · Prisma 6 · PostgreSQL 14+ · AWS SDK for JavaScript v3
(S3 client + presigner) · Argon2id · pino · helmet · express-rate-limit · React 19 · React Router 7 · Vite 8 ·
Vitest · Supertest · React Testing Library · Playwright (e2e smoke). Exact versions are locked in `package-lock.json`.

## Prerequisites

- Node.js **22.12+** and npm 10+
- PostgreSQL **14+** (16 used in development)
- For real storage: a Lightsail bucket and a bucket access key (see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md))

## Local development

```bash
npm ci                                  # installs backend + frontend (npm workspaces)
cp .env.example .env                    # then edit values (see below)
npm run db:migrate                      # applies prisma/migrations to DATABASE_URL
npm run bootstrap:superadmin -- --email you@tekpro.example --name "Your Name"
npm run dev:backend                     # API on http://localhost:3000
npm run dev:frontend                    # SPA on http://localhost:5173 (proxies /api to :3000)
```

Minimum `.env` changes for development:

- `DATABASE_URL` – your local PostgreSQL database
- `SESSION_SECRET` – `openssl rand -base64 48`
- `APP_BASE_URL=http://localhost:5173`
- `STORAGE_*` – a **non-production** bucket (or any S3-compatible endpoint, e.g. MinIO with
  `STORAGE_ENDPOINT=http://localhost:9000` and `STORAGE_FORCE_PATH_STYLE=true`), with browser CORS
  allowing `http://localhost:5173`
- `MAIL_DRIVER=console` to print invitation/reset links in the API console (development only)

`STORAGE_DRIVER=memory` exists only for automated tests and is rejected in production.

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | Generate the Prisma client, compile the API to `backend/dist`, type-check and build the SPA to `frontend/dist` |
| `npm start` | Start the compiled API (`backend/dist/server.js`) |
| `npm test` | Backend (unit + integration + security) and frontend test suites |
| `npm run test:storage-integration` | Real S3-compatible storage tests (needs `STORAGE_IT_*`, see [docs/TESTING.md](docs/TESTING.md)) |
| `npm run lint` / `npm run typecheck` | ESLint / TypeScript checks |
| `npm run db:migrate` | `prisma migrate deploy` |
| `npm run bootstrap:superadmin -- --email … --name …` | One-time creation of the first Super Admin |
| `npm run storage:check` | Diagnose bucket access, pre-signed URLs, multipart support and privacy |
| `npm run jobs -- maintenance` | Expire abandoned uploads, purge deleted documents past retention, prune sessions |
| `npm run jobs -- reconcile [--fix]` | Compare storage with the database; report (or repair) orphans and missing objects |

Backend tests need a disposable PostgreSQL database whose name contains `test`
(default `postgresql://portal:portal@localhost:5432/portal_test`, override with `TEST_DATABASE_URL`).

## Documentation

- [docs/PRD.md](docs/PRD.md) – product requirements
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – components, data flows, upload/download, failure recovery
- [docs/API.md](docs/API.md) – endpoints, permissions, parameters, responses, error codes
- [docs/SECURITY.md](docs/SECURITY.md) – threat model, permission model, known limitations
- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) – step-by-step production deployment on Lightsail
- [docs/BACKUP_RECOVERY.md](docs/BACKUP_RECOVERY.md) – backups, restore, reconciliation
- [docs/TESTING.md](docs/TESTING.md) – test suites, how to run them, outstanding integration tests

## Status

See the "Production readiness" section of [docs/TESTING.md](docs/TESTING.md). In short: the
application is implemented and tested locally (unit, integration, security, S3-protocol tests against
an emulator, and a browser smoke test), but it has **not yet been verified against a real Lightsail
bucket or deployed**. Those checks are mandatory before production use.
