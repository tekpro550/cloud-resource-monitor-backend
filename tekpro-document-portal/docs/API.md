# API Reference (`/api/v1`)

## Conventions

- JSON over HTTPS. Authentication is the `tdp_session` cookie (`__Host-tdp_session` in production),
  set by `POST /auth/login`. Browsers must send credentials (same origin recommended).
- **CSRF:** every `POST`/`PUT`/`PATCH`/`DELETE` from an authenticated session must include
  `X-CSRF-Token: <csrfToken>` (from `/auth/login` or `/auth/me`). A foreign `Origin` header is rejected.
- **Success:** `{ "data": … }`. Lists: `{ "data": { "items": [...], "pagination": { page, pageSize, total, totalPages } } }`.
  Pagination parameters: `page` (≥1, default 1), `pageSize` (1–100, default 25).
- **Errors:** `{ "error": { "code", "message", "details"?, "requestId" } }`. Every response carries `X-Request-Id`.
- IDs are UUIDs; malformed ids are rejected with 400.
- Resources outside the caller's scope return **404** (existence is not disclosed).

### Error codes

| HTTP | code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Invalid body/query/params (`details` lists fields) |
| 401 | `UNAUTHENTICATED` | No valid session |
| 401 | `SESSION_EXPIRED` | Session expired, revoked or account deactivated |
| 403 | `FORBIDDEN` | Authenticated but not permitted |
| 403 | `CSRF_INVALID` | Missing/invalid CSRF token or disallowed origin |
| 404 | `NOT_FOUND` | Missing or not visible to the caller |
| 409 | `DUPLICATE` | Unique value already used (email, customer code, sibling folder name, assignment) |
| 409 | `FOLDER_NOT_EMPTY` | Folder delete needs `recursive` + confirmation (`details: {subfolders, documents}`) |
| 409 | `INVALID_STATE` | Operation not valid in the resource's current state |
| 409/422/400 | `UPLOAD_VERIFICATION_FAILED` | Object missing (409), size mismatch (422), parts invalid (400) |
| 410 | `UPLOAD_EXPIRED` | Upload session expired |
| 413 | `FILE_TOO_LARGE` / `PAYLOAD_TOO_LARGE` / `STORAGE_QUOTA_EXCEEDED` | File above limit / JSON body above 256 KB / upload would exceed the customer's storage limit |
| 415/422 | `FILE_TYPE_NOT_ALLOWED` | Extension not allowed (415) or content does not match type (422) |
| 429 | `RATE_LIMITED` | Too many requests |
| 503 | `STORAGE_UNAVAILABLE` | Object storage failed; retry later |
| 500 | `INTERNAL_ERROR` | Unexpected error (details only in server logs) |

Roles: **SA** Super Admin · **TU** Tekpro User (assigned customers only) · **CA** Customer Admin · **CU** Customer User.

## Health

| Method | Path | Auth | Response |
|---|---|---|---|
| GET | `/health/live` | none | `{status:"ok"}` |
| GET | `/health/ready` | none | 200 `{status:"ok", checks:{database, storage}}` or 503 `degraded` |

## Authentication

| Method | Path | Who | Body | Notes |
|---|---|---|---|---|
| POST | `/auth/login` | anyone (rate limited) | `{email, password}` | Sets cookie; returns `{user, csrfToken, features}`. Generic 401 for every failure |
| POST | `/auth/logout` | any | – | 204; revokes the session |
| GET | `/auth/me` | any authenticated | – | `{user, csrfToken, features:{activityAccess}}` |
| POST | `/auth/forgot-password` | anyone (rate limited) | `{email}` | Always 202 with the same message |
| POST | `/auth/reset-password` | anyone (rate limited) | `{token, newPassword}` | Single-use; also accepts invitation tokens; revokes all sessions |
| POST | `/auth/change-password` | any authenticated | `{currentPassword, newPassword}` | Revokes all sessions, issues a new one |

Password policy: ≥ `PASSWORD_MIN_LENGTH` (12), ≤ 256, three of four character classes, not the
email name, not a single repeated character.

## Customers

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/customers?q&status&page&pageSize` | SA all · TU assigned · CA/CU own | Staff also get `documentCount`, `totalBytes` |
| POST | `/customers` | SA | `{name, customerCode}` (code upper-cased, `^[A-Z0-9][A-Z0-9_-]{1,31}$`) |
| GET | `/customers/:customerId` | in scope | |
| PATCH | `/customers/:customerId` | SA | `{name?, status?, storageQuotaBytes?}`; deactivation revokes customer users' sessions; `storageQuotaBytes` (positive integer, or `null` for no limit) is audited as `customer.storage_quota_changed` |
| GET | `/customers/:customerId/storage-usage` | SA, TU (assigned), CA (own) | `{usedBytes, documents, deletedPendingPurge, uploading, quotaBytes, availableBytes, location, bucketManagement: {allowed, available, bucketPrefix, documentsInBucket}}`. Used space = uploads in progress + available + deleted-but-not-purged documents. Tekpro's platform bucket name is never returned |
| GET | `/customers/:customerId/stats` | SA, TU (assigned) | documents by status, folders, active users, last 24 h |
| GET | `/customers/:customerId/users` | SA | |
| GET | `/customers/:customerId/assignments` | SA | |
| POST | `/customers/:customerId/assignments` | SA | `{userId}` – must be an active Tekpro User |
| DELETE | `/customers/:customerId/assignments/:userId` | SA | Effective immediately |

## Users (Super Admin only)

| Method | Path | Notes |
|---|---|---|
| GET | `/users?q&role&status&customerId&scope=staff\|customer&page&pageSize` | |
| POST | `/users` | `{email, fullName, role, customerId?}`. Customer roles require `customerId`; platform roles must not have one. Returns `{user, invite:{emailSent, link?}}` (`link` only if `ALLOW_ADMIN_RESET_LINKS=true`) |
| GET | `/users/:userId` | `{user, assignments, folderPermissions}` |
| PATCH | `/users/:userId` | `{fullName?, email?, role?}`. Role changes only within platform or within customer roles, never on self, never removing the last active SA; revokes sessions |
| POST | `/users/:userId/deactivate` | Not self, not the last SA; revokes sessions and unused tokens |
| POST | `/users/:userId/activate` | Also clears lockout |
| POST | `/users/:userId/password-reset` | Sends reset (or invitation if no password yet) |
| PUT | `/users/:userId/folder-permissions/:folderId` | `{permission: "DOWNLOAD"\|"VIEW"\|"NONE"}`; Customer Users only; folder must be in the user's customer |
| DELETE | `/users/:userId/folder-permissions/:folderId` | |

## Folders

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/customers/:customerId/folders` | in scope | Visible folders only, with `access` (`VIEW`/`DOWNLOAD`/`MANAGE`) and `documentCount`. For customer roles, a folder whose parent is invisible is returned with `parentFolderId: null` |
| POST | `/customers/:customerId/folders` | SA, TU | `{name, parentFolderId?}`; max depth 20; sibling names unique (case-insensitive) |
| GET | `/folders/:folderId` | VIEW | Includes visible `breadcrumb` |
| PATCH | `/folders/:folderId` | SA, TU | `{name?, parentFolderId? (null = top level), hiddenFromCustomer? (SA only)}`; moves are same-customer and cycle-checked |
| DELETE | `/folders/:folderId` | SA, TU (if `staffCanDeleteFolders`) | Body `{recursive?: boolean, confirmName?: string}`; see deletion policy |
| GET | `/folders/:folderId/permissions` | SA | Customer-user grants on the folder |

## Documents

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/customers/:customerId/documents` | in scope | Query: `folderId`, `recursive=true`, `q` (name, literal match), `type` (`pdf`, `document`, `spreadsheet`, `presentation`, `image`, `archive`, `drawing`, `email`, or an extension), `from`, `to` (ISO dates), `sort=name\|size\|date`, `order=asc\|desc`, `status` (staff only: `AVAILABLE`, `PENDING_UPLOAD`, `UPLOAD_FAILED`, `DELETED`, `MISSING_OBJECT`), pagination. Each item has `canDownload` |
| GET | `/documents/:documentId` | VIEW | Customer roles get the approved metadata subset |
| GET | `/documents/:documentId/download` | DOWNLOAD, status AVAILABLE | `{url, expiresAt, filename, sizeBytes}`; `Cache-Control: no-store`; audited |
| PATCH | `/documents/:documentId` | SA, TU | `{displayName?, folderId?, description?}`; extension cannot change; destination folder must be manageable and in the same customer |
| DELETE | `/documents/:documentId` | SA, TU (if `staffCanDeleteDocuments`) | Soft delete → `DELETED`, `purgeAfter` set |
| POST | `/documents/:documentId/restore` | SA, TU | `{folderId?}` (required if the original folder was deleted) |

Never returned to any client: `objectKey`, storage upload ids, password hashes.

## Uploads (SA, TU)

| Method | Path | Body | Response |
|---|---|---|---|
| POST | `/customers/:customerId/uploads/initiate` | `{folderId, filename, sizeBytes, description?}` | Single: `{uploadId, documentId, mode:"SINGLE", expiresAt, upload:{url, method:"PUT", headers, expiresAt}}` – send `PUT url` with exactly `headers` and the file body. Multipart: `{uploadId, documentId, mode:"MULTIPART", partSize, partCount, expiresAt}` |
| POST | `/uploads/:uploadId/parts` | `{partNumbers: number[]}` (≤100 per call) | `{parts:[{partNumber, url, method, expiresAt}]}` – PUT each part; keep the `ETag` response header |
| POST | `/uploads/:uploadId/complete` | Single: `{}`. Multipart: `{parts:[{partNumber, etag}]}` (all parts) | The document (`AVAILABLE`). Idempotent |
| POST | `/uploads/:uploadId/abort` | – | 204 |

Only the user who initiated an upload (or a Super Admin) can continue, complete or abort it, and only
while they still have access to the customer.

## Storage connectors (customer-owned storage)

See [STORAGE_CONNECTORS.md](STORAGE_CONNECTORS.md).

| Method | Path | Who | Notes |
|---|---|---|---|
| GET | `/customers/:customerId/storage-connector` | SA; TU (assigned, summary only) | `{mode: "PLATFORM"\|"CUSTOMER", connector, portalPrincipalArn?, setup?: {trustPolicy, permissionsPolicy, corsConfiguration}}`. Never includes secrets |
| PUT | `/customers/:customerId/storage-connector` | SA | `{provider: "AWS_S3"\|"LIGHTSAIL"\|"S3_COMPATIBLE", bucket, region, endpoint? (S3_COMPATIBLE only, public https), forcePathStyle?, authType: "ASSUME_ROLE"\|"ACCESS_KEY", roleArn?, accessKeyId?, secretAccessKey?}`. Lightsail requires ACCESS_KEY. Omitted key id/secret keep the stored ones. Location fields cannot change while documents are stored (409). Always resets status to `PENDING_VERIFICATION` |
| POST | `/customers/:customerId/storage-connector/verify` | SA | Live checks; `{result: {ok, checkedAt, checks:[{id,label,ok,detail?}]}, connector}`; status becomes `ACTIVE` or `FAILED` (stays `DISABLED` if disabled) |
| POST | `/customers/:customerId/storage-connector/disable` | SA | Stops new uploads |
| POST | `/customers/:customerId/storage-connector/enable` | SA | Back to `PENDING_VERIFICATION` |
| DELETE | `/customers/:customerId/storage-connector` | SA | 409 while documents reference it |
| POST | `/customers/:customerId/storage-connector/bucket` | SA; CA (own, when `customerAdminCanManageStorage`) | `{bucket, region}`; name must start with the customer's prefix (`tekpro-<code>-`). Creates the bucket in the customer's account (public access blocked, owner-enforced, SSE-S3, versioning, CORS), switches the connection to it and runs verification: `{result, connector}`. 409 if the current bucket holds documents, the name exists or is taken; 400 if the customer's role lacks the bucket management policy. Not for Lightsail |
| DELETE | `/customers/:customerId/storage-connector/bucket` | as above | `{confirmBucket}` must equal the bucket name. Refused (409) while documents use it. Deletes the portal's objects and their versions under the customer prefix, then the bucket (409 if other files remain). The connection is removed (or disabled if purged document records still reference it): `{deleted, storage}` |
| GET | `/storage-connectors/portal-identity` | SA | `{principalArn}` – Tekpro principal for trust policies (503 if not configured) |

While a customer has a connector that is not `ACTIVE`, `POST /customers/:id/uploads/initiate` returns
409 `INVALID_STATE` (no fallback to platform storage).

## Audit

`GET /audit-logs?customerId&actorUserId&action(prefix)&outcome&from&to&page&pageSize`

| Role | Scope |
|---|---|
| SA | Everything, including IP addresses and metadata |
| TU | Records of assigned customers, if `staffAuditAccess` (default on) |
| CA | Download/login/logout events by users of their own organisation, if `customerAdminActivityAccess` (default on) |
| CU | Their own download/login/logout events, if `customerUserActivityAccess` (default off) |

Action names: `auth.login.succeeded|failed`, `auth.logout`, `auth.password_reset.requested|completed|failed`,
`auth.password.changed`, `user.created|updated|role_changed|deactivated|activated|password_reset_triggered`,
`customer.created|updated|deactivated|activated`, `assignment.created|removed`,
`folder.created|renamed|moved|visibility_changed|deleted`, `permission.changed|removed`,
`document.upload.initiated|completed|failed|aborted|expired`, `document.download.link_issued`,
`document.renamed|moved|updated|deleted|restored|purged|purge_failed|object_missing`,
`storage.orphan_removed`, `storage.misplaced_object`, `security.access_denied`, `settings.changed`,
`storage_connector.created|updated|verified|verification_failed|disabled|enabled|deleted`.

## Settings and statistics (Super Admin)

| Method | Path | Notes |
|---|---|---|
| GET | `/settings` | `{settings, operational: {values, defaults, overridden}, environment: {storageDriver, mailDriver, jobsEnabled}}` |
| PATCH | `/settings` | Any of `staffAuditAccess`, `staffCanDeleteDocuments`, `staffCanDeleteFolders`, `customerAdminActivityAccess`, `customerUserActivityAccess`, `customerAdminCanManageStorage` (booleans); audited |
| PATCH | `/settings/operational` | Any of `uploadMaxFileSizeBytes` (1 MiB–5 TiB), `uploadMultipartThresholdBytes` and `uploadPartSizeBytes` (5 MiB–5 GiB), `uploadAllowedExtensions` (executables and scripts refused), `uploadUrlTtlSeconds` (60–900), `uploadSessionTtlSeconds` (300 s–7 days), `downloadUrlTtlSeconds` (30–900), `deletedDocumentRetentionDays` (0–3650), `sessionTtlSeconds` (300 s–30 days), `sessionIdleTimeoutSeconds` (60 s–24 h, not above the session length); `null` resets a value to the server default. Applied immediately and picked up by other instances within 30 s; audited with before/after values |
| GET | `/stats/overview` | Totals, last 24 h uploads, recent uploads/downloads/admin events |
| GET | `/stats/storage` | Per-customer counts/bytes by status, storage limit and connection summary; daily uploads for 30 days |
