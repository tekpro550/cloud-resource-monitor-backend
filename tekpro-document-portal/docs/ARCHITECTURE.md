# Architecture

## 1. Overview

A modular monolith: one Node.js process exposes the versioned REST API (`/api/v1`) and, in the
recommended deployment, also serves the built React SPA from the same origin. PostgreSQL and
Amazon Lightsail Object Storage are separate managed services.

```
             HTTPS                          SQL (TLS)
 Browser ───────────▶ Nginx/TLS ──▶ Node.js API ───────────▶ PostgreSQL
    │                              (Express)                (users, customers, folders,
    │                                 │                      documents, permissions,
    │                                 │ S3 API (SigV4, TLS)  sessions, audit log)
    │                                 ▼
    └──── pre-signed PUT/GET ───▶ Lightsail bucket (private)
          (direct, short-lived)
```

| Component | Responsibility |
|---|---|
| React SPA (`frontend/`) | UI only. Hides actions the role cannot perform; holds the CSRF token in memory; uploads/downloads directly to storage |
| API (`backend/src/app.ts`) | Authentication, authorisation, validation, metadata, signing storage requests, audit |
| `AccessPolicy` (`modules/permissions/accessPolicy.ts`) | The single authorisation engine every route uses |
| `StorageAdapter` (`storage/`) | `S3StorageAdapter` (AWS SDK v3) in all real environments; `MemoryStorageAdapter` for tests only |
| Jobs (`jobs/`) | Upload expiry, purge of deleted documents, auth-record pruning, reconciliation |
| PostgreSQL | System of record for everything except file bytes |
| Lightsail bucket | File bytes only, under `customers/{customerId}/documents/{documentId}` |

## 2. Data model

Prisma schema: `backend/prisma/schema.prisma`; SQL: `backend/prisma/migrations/`.

| Entity | Notes |
|---|---|
| `User` | `role` enum, `status`, nullable `customerId`. CHECK constraint: platform roles have no customer, customer roles must have one. Lockout counters. Password hash nullable until the invitation is accepted |
| `Customer` | Unique `customerCode` (CHECK on format), `status` |
| `TekproUserCustomerAssignment` | Unique `(userId, customerId)`; controls which customers a Tekpro User may manage |
| `Folder` | `customerId`, `parentFolderId`; composite FK `(parentFolderId, customerId) → Folder(id, customerId)` so a parent is always in the same customer; `hiddenFromCustomer`; soft delete via `deletedAt`; partial unique index on live sibling names |
| `Document` | Composite FK `(folderId, customerId) → Folder(id, customerId)`; `objectKey` unique and CHECK-constrained to `customers/{customerId}/documents/{id}`; `status` lifecycle; `sizeBytes`, `storageEtag`, `checksum` (reserved), retention fields |
| `CustomerUserFolderPermission` | Unique `(userId, folderId)`; composite FKs to `User(id, customerId)` and `Folder(id, customerId)` so a grant cannot cross customers |
| `UploadSession` | One per document upload: mode, expected size, multipart upload id (server-only), part plan, status, expiry |
| `Session` | HMAC of the session token, CSRF token, expiry, revocation |
| `PasswordToken` | HMAC of reset/invitation tokens, single use, expiry |
| `SystemSetting` | Policy flags and job lease locks |
| `AuditLog` | Append-only; UPDATE/DELETE/TRUNCATE rejected by trigger |

Deletion policy: customers, folders, documents and users are never hard-deleted by the application
(deactivation / soft delete). Foreign keys use `RESTRICT` for business data so nothing cascades
across tenants; `CASCADE` is used only for a user's own sessions, tokens and grants.

## 3. Authentication

- `POST /auth/login` verifies the Argon2id hash (dummy verification for unknown emails to equalise
  timing), applies lockout after `LOGIN_MAX_FAILED_ATTEMPTS`, revokes any presented session and
  creates a new one (rotation).
- The session token (256-bit random) is sent only as an `HttpOnly`, `SameSite=Strict` cookie
  (`__Host-` prefixed and `Secure` in production). The database stores `HMAC-SHA256(SESSION_SECRET, token)`.
- Every request reloads the session, user and customer from the database; idle timeout, absolute
  expiry, revocation, user deactivation and customer deactivation all take effect immediately.
- CSRF: synchroniser token per session, returned in the login/me response, kept in memory by the
  SPA and required in `X-CSRF-Token` for every state-changing request; plus an Origin check.
- Password change/reset, role change, email change and deactivation revoke the user's sessions.

## 4. Authorisation and tenant isolation

`AccessPolicy` resolves access from the database for every request, never from client-supplied ids:

| Check | Super Admin | Tekpro User | Customer Admin | Customer User |
|---|---|---|---|---|
| Customer access | all | assigned + customer active | own customer | own customer |
| Folder level | MANAGE | MANAGE (assigned) | DOWNLOAD on non-hidden folders | from grants (see below) |
| Document visibility | all statuses | all statuses (assigned) | AVAILABLE only | AVAILABLE only |

Levels: `VIEW < DOWNLOAD < MANAGE`. Customer roles can never reach `MANAGE`, so no folder grant
can confer upload/rename/move/delete.

Customer User inheritance (`computeCustomerAccess`):
1. A folder hidden from the customer, or under a hidden folder, is invisible.
2. A `NONE` grant on a folder or any ancestor denies the whole subtree.
3. Otherwise the nearest explicit grant (`VIEW`/`DOWNLOAD`) walking upward applies.
4. No grant on the path → no access.

Resources the caller may not see return **404** (not 403) so identifiers cannot be probed; visible
resources with an insufficient level return 403. Every denial writes a `security.access_denied` audit
record. Database constraints (composite FKs, CHECKs) are a second line of defence.

## 5. Upload flow

```
SPA                         API                                   Storage
 │ POST /customers/:c/uploads/initiate {folderId, filename, size}
 │──────────────────────────▶ auth → requireCustomerManage → requireFolder(MANAGE)
 │                            validate name/extension/size
 │                            INSERT Document(PENDING_UPLOAD) + UploadSession(INITIATED) + audit (1 tx)
 │                            size ≤ threshold: presign PUT (Content-Type & Content-Length signed)
 │                            size > threshold: CreateMultipartUpload ───────────────▶
 │◀────────────────────────── {uploadId, documentId, mode, url | partSize/partCount}
 │ (multipart) POST /uploads/:id/parts {partNumbers} → pre-signed UploadPart URLs (batches)
 │ PUT bytes directly (XHR progress; multipart: 3 parallel parts, 3 retries) ─────────▶
 │ POST /uploads/:id/complete {parts?}
 │──────────────────────────▶ re-check assignment + folder; claim session (INITIATED→COMPLETING)
 │                            multipart: CompleteMultipartUpload ─────────────────────▶
 │                            HeadObject: exists? size == declared? ──────────────────▶
 │                            GetObject bytes 0-4099: signature matches extension? ───▶
 │                            Document AVAILABLE + session COMPLETED + audit (1 tx)
 │◀────────────────────────── document
```

- The object key is generated by the server; the browser never chooses or sees it.
- The Content-Type is derived server-side from the extension; downloads are always forced to
  `application/octet-stream` + `attachment`.
- Completion is idempotent (a completed session returns the document) and retry-safe (storage or
  database errors return the session to `INITIATED`).
- Verification failures: missing object → 409 (client may upload again); size mismatch or content
  mismatch → object deleted, document `UPLOAD_FAILED`, 422.
- Limits: `UPLOAD_MAX_FILE_SIZE_BYTES` (default 5 GiB). Multipart above
  `UPLOAD_MULTIPART_THRESHOLD_BYTES` (100 MiB) with `UPLOAD_PART_SIZE_BYTES` (64 MiB) parts, automatically
  enlarged so no upload exceeds S3's 10,000-part limit. The browser reads files with `Blob.slice`,
  so large files are never loaded into memory.

## 6. Download flow

`GET /documents/:id/download`: authenticate → load document → customer access → folder level
`DOWNLOAD` → status `AVAILABLE` → pre-signed `GetObject` (`DOWNLOAD_URL_TTL_SECONDS`, default 300 s,
with `response-content-disposition=attachment` and `Cache-Control: private, no-store`) → audit
`document.download.link_issued` (URL is never logged) → JSON `{url, expiresAt, filename}`. The SPA
hands the URL to the browser's native download handling. The audit event records that a link was
issued; the portal does not claim the download completed.

## 7. Deletion and consistency

PostgreSQL transactions cannot include storage operations, so every cross-system workflow is a
state machine that can be resumed:

| Situation | Handling |
|---|---|
| Upload succeeded, completion never called | Session expires → `cleanupExpiredUploads` aborts multipart / deletes object, document `UPLOAD_FAILED` |
| Completion called, object missing | 409, session stays `INITIATED` for retry |
| Storage error during completion | Session returns to `INITIATED`; 503 `STORAGE_UNAVAILABLE` |
| Process crash while `COMPLETING` | Cleanup job treats sessions stuck > 1 h after expiry as abandoned |
| Document deleted | Status `DELETED` immediately (invisible to customers); purge job deletes the object after `DELETED_DOCUMENT_RETENTION_DAYS`, then `PURGED`; storage failures are retried and audited |
| Object exists without a record / with a purged record | `reconcile --fix` removes it (24 h grace for in-flight uploads) |
| Record points to a missing object | `reconcile --fix` marks it `MISSING_OBJECT` (hidden from customers, visible to staff) |

Renames and moves change metadata only; object keys are immutable, so no copy/delete is required.

Folder deletion: empty → soft delete. Non-empty → requires `recursive: true` and the exact folder name;
the subtree's folders are soft-deleted and its documents move to `DELETED` (recoverable); refused above
5,000 documents.

## 8. Storage integration

`S3StorageAdapter` uses `@aws-sdk/client-s3` with `requestChecksumCalculation/responseChecksumValidation:
WHEN_REQUIRED` (recent SDKs otherwise add `x-amz-checksum-*` parameters to pre-signed URLs, which
browsers cannot satisfy and some S3-compatible services reject), 3 attempts, bounded timeouts, and
maps provider errors to typed `StorageError`s (`ACCESS_DENIED`, `NOT_FOUND`, `TIMEOUT`,
`INVALID_SIGNATURE`, `EXPIRED`, `INCOMPLETE_UPLOAD`, `UNAVAILABLE`) whose messages contain no secrets.
Clients receive a generic 503.

Lightsail buckets are S3 buckets served from the regional endpoint and accessed with SigV4 and a
per-bucket access key. Feature support must be confirmed for the actual bucket with
`npm run storage:check` (see DEPLOYMENT.md).

## 8a. Customer-owned storage (connectors)

`StorageResolver` (`storage/resolver.ts`) decides which bucket each operation uses:

- **New uploads:** the customer's `StorageConnector` if one exists (must be `ACTIVE`, otherwise 409 —
  no fallback), else platform storage. The document stores `storageConnectorId` (composite FK to the
  connector of the same customer).
- **Everything else** (part URLs, completion, downloads, restore, purge, expiry cleanup) uses the
  storage recorded on the document.
- Connector adapters are cached per connector version. Role connectors obtain temporary credentials via
  STS `AssumeRole` + External ID; the reported expiry is moved 25 minutes earlier so pre-signed URLs never
  outlive their credentials. Access-key connectors decrypt the AES-256-GCM secret.
- Customer credentials are scoped to `customers/<customerId>/`, so connectivity checks use a prefix
  listing instead of HeadBucket.
- The page CSP `connect-src` is computed per request from configured connectors (cached 60 s).

Details and setup: [STORAGE_CONNECTORS.md](STORAGE_CONNECTORS.md).

## 9. Background jobs

`npm run jobs -- maintenance` (or `JOBS_ENABLED=true`) runs upload expiry, purge and pruning under a
database lease lock, so multiple instances never run it concurrently. `reconcile` is run manually or
on a slower schedule.

## 10. Scaling notes

- The API is stateless except for in-memory rate-limit counters; for several instances use a shared
  rate-limit store (e.g. Redis) and the provided job lock.
- File transfer throughput is between browsers and object storage; the API handles only small JSON
  requests, so 3 GB/day of uploads is a negligible API load. Actual throughput limits must be measured
  against the real bucket (see TESTING.md).
- Folder access maps are computed per request from the customer's folder list; fine for thousands of
  folders per customer. Beyond that, cache per (user, customer) or materialise effective permissions.
- Filename search uses `ILIKE` with indexes on `(customerId, status, displayName)`; add `pg_trgm` GIN
  indexes if search over very large collections becomes slow.
