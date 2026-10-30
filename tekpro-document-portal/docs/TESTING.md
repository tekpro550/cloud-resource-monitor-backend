# Testing

## 1. Suites

| Suite | Location | Runs against | Tests |
|---|---|---|---|
| Backend unit | `backend/tests/unit` | pure functions | permission inheritance, filename/Content-Disposition validation, content-signature checks, password policy, audit redaction, configuration validation (production fail-safes, empty values), S3 error mapping |
| Backend integration | `backend/tests/integration` | real PostgreSQL + in-memory storage adapter, via Supertest | authentication & sessions, Super Admin administration, folders, uploads & downloads, documents (search/sort/pagination/rename/move/delete/restore/purge), maintenance jobs & reconciliation |
| Backend security | `backend/tests/security` | same | role enforcement for all four roles via direct API calls; cross-tenant isolation (customer/folder/document ids, request bodies, query parameters, search leakage, DB constraints) |
| Storage integration | `backend/tests/storage` | a real S3-compatible endpoint | `S3StorageAdapter` (pre-signed PUT/GET, HEAD, ranged GET, multipart complete/abort, list/delete) and a full API upload→download through real storage; strict provider checks (private bucket, URL expiry, signed Content-Length) |
| Frontend | `frontend/tests` | jsdom + React Testing Library, mocked `fetch`/XHR | role-based navigation and route guards, customer screens without admin controls, staff upload/action controls, download flow and errors, error/empty/retry states, search/sort parameters, breadcrumbs, login validation, CSRF header, direct-to-storage uploader (single, multipart, cancel), upload error display |
| Browser smoke (e2e) | `tests/e2e/portal-smoke.mjs` | a running deployment (Playwright/Chromium) | end-to-end user journey across Super Admin and customer user (desktop and mobile viewport) |

## 2. Running

```bash
# Backend: needs a disposable PostgreSQL database whose name contains "test"
export TEST_DATABASE_URL=postgresql://portal:portal@localhost:5432/portal_test
npm run test:backend      # applies migrations (migrate deploy), then unit + integration + security
npm run test:frontend
npm test                  # both

# Real S3-compatible storage (non-production bucket or an emulator)
STORAGE_IT_REGION=ap-south-1 STORAGE_IT_BUCKET=<test-bucket> \
STORAGE_IT_ACCESS_KEY_ID=… STORAGE_IT_SECRET_ACCESS_KEY=… \
STORAGE_IT_STRICT=true npm run test:storage-integration
#   STORAGE_IT_ENDPOINT / STORAGE_IT_FORCE_PATH_STYLE=true for emulators,
#   STORAGE_IT_CREATE_BUCKET=true to create the bucket on an emulator.

# Browser smoke test against a running NON-PRODUCTION portal
E2E_BASE_URL=https://staging.portal.example E2E_ADMIN_EMAIL=… E2E_ADMIN_PASSWORD=… \
E2E_SCREENSHOT_DIR=./e2e-shots node tests/e2e/portal-smoke.mjs
```

The backend suites share one database and run serially; each suite truncates the tables it uses
(`resetDb`, which refuses to run unless the database name contains `test`). Tests never touch real
storage unless the `STORAGE_IT_*` variables are set, and the storage tests write only under a unique
`_integration-tests/` prefix that they delete afterwards. Never point any test at production data.

## 3. Results in the development environment (this implementation)

Environment: Linux, Node.js 22.22, PostgreSQL 16 (local), moto 5 S3 emulator (local), Chromium via Playwright.

| Check | Result |
|---|---|
| `npm run lint` | pass |
| `npm run typecheck` (backend + frontend) | pass |
| Backend unit + integration + security | **156 passed** (10 files) |
| Frontend | **22 passed** (2 files) |
| Storage integration vs moto emulator | **8 passed**, 3 skipped (strict provider checks need a real bucket) |
| `npm run build` | pass (API compiled, SPA built) |
| Browser smoke test vs local stack (API in development mode serving the built SPA, PostgreSQL, moto with CORS) | **13/13 steps passed**: Super Admin sign-in, create customer, create folder, single + 7 MiB multipart direct uploads verified by the server, disguised `.pdf` executable rejected, invite customer user, grant DOWNLOAD, set password via invitation and sign in on a mobile viewport, customer sees no management controls, pre-signed download with byte-for-byte comparison, admin page and upload API refused for the customer, download visible in audit log, no CSP/CORS console errors |
| Super Admin bootstrap CLI | verified: weak password rejected; first run creates the Super Admin; second run refused |
| Production mode | verified: refuses `http://` base URL; issues `__Host-` `Secure; HttpOnly; SameSite=Strict` cookie and HSTS |

## 4. Coverage of the required scenarios

| Requirement | Tests |
|---|---|
| Login success / invalid credentials / inactive accounts / logout / expired sessions / password reset / session invalidation | `integration/auth.test.ts` |
| Super Admin operations; unauthenticated users rejected | `integration/superAdmin.test.ts`, `integration/auth.test.ts` |
| Tekpro User: assigned access, unassigned denied, cannot create customers or manage users, assignment changes immediate | `security/roles.test.ts`, `integration/superAdmin.test.ts` |
| Antrix Admin: downloads; cannot upload/rename/move/delete, create users or change permissions | `security/roles.test.ts` |
| Antrix Customer User: assigned folders only, inheritance, `NONE`, VIEW vs DOWNLOAD, no writes | `security/roles.test.ts`, `unit/accessPolicy.test.ts` |
| Cross-tenant attempts via customer ids, folder ids, document ids, bodies, query parameters; search leakage | `security/tenantIsolation.test.ts` |
| Upload initiation/completion, missing object, invalid object (size/content), duplicates, storage errors, partial failures, expired sessions | `integration/uploads.test.ts`, `integration/jobs.test.ts` |
| Download URL generation, TTL, audit without URL, storage errors | `integration/uploads.test.ts` (downloads) |
| Deletion failures and retries, orphan reconciliation | `integration/documents.test.ts`, `integration/jobs.test.ts` |
| Expired URL behaviour | `storage/s3Adapter.test.ts` (strict mode – real bucket only) |
| Frontend role navigation, upload/download controls, error states, customers see no admin actions | `frontend/tests/*.test.tsx` |

## 5. Outstanding integration tests (must be completed before production)

These could not be executed here because no Lightsail credentials or deployment target were available:

1. **Real Lightsail bucket:** `npm run storage:check` and `STORAGE_IT_STRICT=true npm run test:storage-integration`
   against a dedicated non-production Lightsail bucket. This validates SigV4 signing at the real
   endpoint, multipart support, bucket privacy (unsigned GET refused), URL expiry enforcement and
   signed Content-Length enforcement. The emulator accepted requests without enforcing these.
2. **Lightsail CORS:** confirm a CORS rule can be applied to the bucket and that browser uploads
   (including multipart, which needs the exposed `ETag`) succeed from the production origin.
3. **Deployment smoke test:** run `tests/e2e/portal-smoke.mjs` against the staging deployment over HTTPS.
4. **Email delivery:** verify invitation and reset emails through the production SMTP service.
5. **Backup/restore rehearsal:** BACKUP_RECOVERY.md §3.1 on a staging copy.

## 6. Load and capacity

Not yet measured. No throughput or concurrency figures are claimed. Recommended before go-live:

- Upload 3–5 GB in a mix of file sizes (including several ≥ 1 GB multipart files) from a typical
  client network to the real bucket; record duration and failure/retry counts. File bytes do not pass
  through the API, so this mainly measures client ↔ storage bandwidth.
- Load the API (e.g. k6) with listing/search/download-link requests at the expected peak concurrency
  plus a margin, on the chosen instance size; watch p95 latency, CPU and DB connections. Note that login
  is deliberately CPU-heavy (Argon2id).
- Seed a customer with ~50k documents and ~2k folders and check listing/search latency; add `pg_trgm`
  indexes or cache folder access maps if needed (ARCHITECTURE.md §10).

## 7. Production readiness

The application is **not yet production-ready** until §5 is completed and the DEPLOYMENT.md checklist
is signed off. Malware scanning is not part of version 1 (SECURITY.md §5).
