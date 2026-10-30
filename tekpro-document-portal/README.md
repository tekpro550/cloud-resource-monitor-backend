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
| Customer-owned storage | Per-customer **storage connector**: keep a customer's documents in their own AWS S3 bucket (cross-account IAM role + External ID, no stored secrets), Lightsail bucket or S3-compatible service (encrypted access key); live verification, CloudFormation template for customers, per-document storage tracking. See [docs/STORAGE_CONNECTORS.md](docs/STORAGE_CONNECTORS.md) |
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

Requirements: Node.js **22.12+** and **Docker Desktop** (running). The setup script starts PostgreSQL and
a local S3-compatible server ([moto](https://github.com/getmoto/moto), standing in for the Lightsail
bucket) with `docker-compose.dev.yml`, writes `.env` (only if it does not exist), installs dependencies,
creates the bucket and applies the migrations.

```bash
git clone -b claude/wizardly-hopper-1j4uwh https://github.com/tekpro550/cloud-resource-monitor-backend.git
cd cloud-resource-monitor-backend/tekpro-document-portal
npm run setup:dev
npm run bootstrap:superadmin -- --email you@tekpro.example --name "Your Name"
npm run dev            # API on :3000 and web app on http://localhost:5173 (Ctrl+C stops both)
```

Notes:

- The bootstrap command prompts for a password (input hidden): at least 12 characters, three of
  lower-case / upper-case / digits / symbols, and not containing the part of your email before the @.
- In development `MAIL_DRIVER=console` prints invitation and reset emails in the terminal, and
  `ALLOW_ADMIN_RESET_LINKS=true` also shows invitation links on screen.
- npm 11.6+/12 only runs dependency install scripts listed in `allowScripts` (`package.json`); the
  required ones (Prisma, argon2, esbuild, fsevents) are pre-approved, so no manual approval is needed.
- If port 5432 or 5050 is already in use, run `PORTAL_PG_PORT=5433 PORTAL_S3_PORT=5051 npm run setup:dev`
  (with no `.env` present yet, so it is generated with those ports).
- moto keeps files in memory: after restarting it, previously uploaded files are gone (their records stay).
- Stop the services with `docker compose -f docker-compose.dev.yml down` (add `-v` to also delete the database).
- To use a real (non-production) Lightsail bucket instead, set the `STORAGE_*` values in `.env` and add a
  bucket CORS rule allowing `http://localhost:5173` (see docs/DEPLOYMENT.md §10).

`STORAGE_DRIVER=memory` exists only for automated tests and is rejected in production.

## Commands

| Command | Purpose |
|---|---|
| `npm run setup:dev` / `npm run dev` | One-time local setup / run API + web app together |
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
- [docs/STORAGE_CONNECTORS.md](docs/STORAGE_CONNECTORS.md) – customer-owned storage (IAM role / access key connectors)
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
