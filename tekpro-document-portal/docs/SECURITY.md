# Security

## 1. Assets and trust boundaries

| Asset | Where | Protection |
|---|---|---|
| Customer documents | Private Lightsail bucket | No public access; only short-lived pre-signed URLs issued after authorisation |
| Metadata, permissions, audit | PostgreSQL | Server-side access only; TLS; least-privilege DB user |
| Storage credentials | Server environment | Never sent to the browser, never logged |
| Sessions | Browser cookie + `Session` table | HttpOnly, SameSite=Strict, Secure, token stored as HMAC |

Trust boundaries: browser ↔ API (untrusted input), browser ↔ storage (pre-signed, time-limited,
key-bound requests), API ↔ PostgreSQL / storage (trusted, credentialled).

## 2. Roles and permissions

| Function | Super Admin | Tekpro User | Customer Admin | Customer User |
|---|---|---|---|---|
| Manage customers, staff, users, assignments, settings | ✔ | ✘ | ✘ | ✘ |
| Browse customers | all | assigned | own | own |
| Create/rename/move/delete folders | ✔ | assigned (delete if enabled) | ✘ | ✘ |
| Upload / rename / move / delete documents | ✔ | assigned (delete if enabled) | ✘ | ✘ |
| Download | ✔ | assigned | non-hidden folders | granted folders (DOWNLOAD) |
| Set folder visibility and customer-user grants | ✔ | ✘ | ✘ | ✘ |
| Audit / activity | all | assigned customers (if enabled) | own organisation's downloads/logins (if enabled) | own downloads/logins (if enabled) |
| See storage space used / limit | all | assigned | own organisation | ✘ |
| Set storage limit, connect customer storage, change limits in Settings | ✔ | ✘ | ✘ | ✘ |
| Create / delete the customer's own bucket | ✔ | ✘ | own organisation (if enabled), only in the customer's AWS account | ✘ |

Bucket management by Customer Admins acts only on their own organisation's connected AWS account, needs the
bucket management policy on the customer's role, is limited to bucket names `tekpro-<code>-*`, and never deletes a
bucket that holds documents or files the portal did not create. Runtime limits (Settings → Limits) are range-checked
on the server: pre-signed URLs never exceed 15 minutes, and executable or script file types can never be allowed.

All rules are enforced by `AccessPolicy` on the server. The frontend hides unavailable actions purely
for usability. Automated tests call the API directly to prove the backend rejects every
customer-side write and every cross-tenant access (`backend/tests/security`).

### Folder permission inheritance (Customer Users)

1. Grants apply to the folder and all descendants.
2. The nearest explicit grant wins: `VIEW` on a subfolder restricts a `DOWNLOAD` on its parent, and
   `DOWNLOAD` on a subfolder can widen a `VIEW` on its parent.
3. `NONE` on a folder or any ancestor denies the entire subtree; no grant elsewhere overrides it.
4. Folders hidden from the customer (or under a hidden folder) are invisible to all customer roles.
5. No grant → no access. Customer roles are capped at `DOWNLOAD`; grants can never confer write access.

Assignment, grant, role and status changes take effect on the next request (permissions are read from
the database on every request; sessions are revoked on role/status changes).

## 3. Threat model and mitigations

| Threat | Mitigation |
|---|---|
| Broken access control / IDOR | Every route loads the resource and checks customer, folder level and state via `AccessPolicy`; ids from URLs/bodies/queries are never trusted; hidden resources return 404; denials are audited |
| Cross-tenant exposure | Customer-scoped queries; composite FKs make cross-customer folder parents, document folders and permission grants impossible in the database; search intersects with visible folders |
| Privilege escalation | Only the Super Admin manages users/roles/assignments; no self role change; role changes limited to the same category; last active Super Admin protected; customer roles capped at DOWNLOAD |
| Unauthorised uploads | Upload endpoints require MANAGE on the customer and folder; session ownership and assignment re-checked at every step |
| Unauthorised downloads | Pre-signed URLs only after the full authorisation chain; 5-minute lifetime; object keys never exposed |
| Expired/mis-scoped upload URLs | PUT URLs sign Content-Type and Content-Length and expire (`UPLOAD_URL_TTL_SECONDS`); part URLs are bound to the multipart upload id; sessions expire |
| Claiming a fake upload | Completion verifies the object exists with the exact size and a matching content signature |
| Malicious filenames / path traversal | Names are metadata only; validated (no separators, control or bidi characters, reserved names); object keys are server-generated UUID paths with a DB CHECK |
| File type spoofing | Extension allow-list plus magic-byte check of the first 4 KB after upload; served as `application/octet-stream` + `attachment` from the storage origin, never rendered by the portal origin |
| Unrestricted size | Per-file maximum enforced at initiation and verified at completion; JSON bodies limited to 256 KB |
| Session theft | HttpOnly + Secure + SameSite=Strict + `__Host-` cookie; HMAC-stored tokens; idle and absolute expiry; rotation on login; revocation on sensitive changes; nothing in localStorage |
| CSRF | SameSite=Strict, synchroniser token header, Origin check |
| XSS | React escaping, no `dangerouslySetInnerHTML`; CSP `default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'` |
| Clickjacking | `frame-ancestors 'none'` |
| SQL injection | Prisma parameterised queries; raw SQL uses tagged templates only; LIKE wildcards escaped |
| Brute force | Per-IP login rate limit, per-account lockout, generic login error, timing equalisation |
| Account enumeration | Identical responses for login failures and password-reset requests |
| Insecure password reset | 256-bit single-use tokens stored as HMAC, 30-minute lifetime, atomic claim, all sessions revoked on use |
| Excessive requests | Global per-IP API rate limit |
| Information disclosure | Uniform error envelope; stack traces, SQL and storage responses only in logs; storage errors become a generic 503 |
| Credential leakage | Secrets only in server env; startup validation; log redaction of cookies, auth headers, passwords, tokens, URLs; request logs omit query strings; audit metadata sanitiser |
| Audit tampering | No API to modify audit records; DB trigger rejects UPDATE/DELETE/TRUNCATE |
| Race conditions | Upload completion claimed atomically; folder structure changes serialised per customer with a row lock; reset tokens claimed atomically; conditional updates for document state |
| Orphaned objects | Upload expiry job, purge job and reconciliation |
| Customer storage credentials (connectors) | Cross-account role with External ID (no stored secret, temporary credentials); access keys AES-256-GCM encrypted and bound to the connector id, never returned or logged; Super Admin only; permissions scoped to `customers/<id>/` |
| SSRF via custom storage endpoints | `https://` public origins only; no credentials, localhost, private or link-local address literals; production refuses the insecure override |
| Connector misuse / data placement | Each document records its storage; location changes refused while documents exist; uploads refused (no fallback) unless the connector is verified ACTIVE |
| Default credentials | None. First Super Admin created by a one-time CLI that refuses to run if one exists |

## 4. Credential handling

- `.env` is git-ignored; only `.env.example` (no secrets) is committed.
- Production refuses to start with a missing/placeholder `SESSION_SECRET`, non-HTTPS `APP_BASE_URL`,
  the memory storage driver or the console mailer.
- Use a Lightsail **bucket access key** (scoped to that bucket) rather than account-level IAM keys.
  Rotate it by creating a second key, deploying it, then deleting the old one.
- The database user should own only the portal database.

## 5. Upload and download security

- Bytes travel browser ↔ storage over TLS; the API never proxies file content.
- Documents are untrusted content: they are never executed or rendered inline by the portal.
- **Malware scanning is not implemented.** The portal does not claim uploaded files are safe.
  Recommended: scan objects with an AV service (e.g. a scanning Lambda/ClamAV worker triggered after
  upload) and add a `PENDING_SCAN` state before `AVAILABLE`.
- A pre-signed URL is a bearer credential for its lifetime (default 5 minutes). Anyone holding it can
  download that one object until it expires. URLs are never logged or stored.

## 6. Audit logging

Recorded: successful/failed logins, logouts, password resets/changes, user creation/update/role
change/deactivation, customer changes, assignments, folder changes, permission changes, upload
initiation/completion/failure/abort/expiry, download link issuance, document rename/move/delete/
restore/purge, denied access, settings changes, reconciliation repairs.
Fields: id, UTC timestamp, actor, customer, action, resource type/id, outcome, request id, IP address,
sanitised metadata. Never recorded: passwords, tokens, cookies, secrets, pre-signed URLs.
IP addresses are kept for security monitoring; define a retention period in your privacy policy.

## 7. Known limitations

- No malware scanning (see above).
- Rate limits are per process (in memory); use a shared store when running multiple instances.
- No multi-factor authentication or SSO in version 1.
- A pre-signed download URL cannot be revoked before it expires.
- Download completion is not tracked; the audit records link issuance only.
- Content checks cover file signatures, not document structure (e.g. a malformed PDF with a valid header passes).
- Lightsail-specific behaviour (bucket privacy, URL expiry enforcement, CORS) has been tested only
  against an S3 emulator in this repository; run `npm run storage:check` and the strict storage tests
  against the real bucket before go-live.
- Password breach-list checks are not implemented; the policy enforces length and variety only.
- Connector endpoints given as hostnames that resolve to private addresses are not detected (DNS-based SSRF); mitigated by Super-Admin-only configuration.
- Customer-owned storage has been tested against an S3/STS emulator, not yet against a real customer AWS account.
