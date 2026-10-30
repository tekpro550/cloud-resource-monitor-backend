# Deployment Guide

The portal has three separately managed components. Object storage hosts **only file bytes**; it
cannot run the API or the database.

| Component | Recommended initial choice | Notes |
|---|---|---|
| Application host | Amazon Lightsail Linux instance, Ubuntu 24.04 LTS, **2 GB RAM / 2 vCPU** | Runs Node.js (API + SPA) behind Nginx with TLS. Argon2id uses ~19 MiB per login; file bytes never touch this host |
| Database | Lightsail managed database, PostgreSQL 16, standard (non-HA) plan to start; HA plan for production SLAs | Automatic daily backups + point-in-time restore |
| Object storage | Lightsail bucket in the same region | Private. 3 GB/day ≈ 90 GB/month ≈ 1 TB/year: choose a plan with headroom and monitor overage, or plan a move to a standard S3 bucket as data grows |

These sizes are assumptions for the stated workload (tens of users, ≥ 3 GB/day uploads). Validate them
with the load checks in [TESTING.md](TESTING.md#load-and-capacity) before relying on them.

## 1. Prerequisites

- AWS account with Lightsail access; a DNS name for the portal (e.g. `portal.tekpro.example`).
- Local machine with the AWS CLI v2 (optional, for bucket configuration) and SSH access.
- An SMTP service for invitation and reset emails (e.g. Amazon SES SMTP credentials).

## 2. Runtime and package versions

- Node.js **22 LTS** (≥ 22.12), npm 10. PostgreSQL 14+ (16 recommended).
- Dependencies are pinned in `package-lock.json`; always install with `npm ci`.

## 3. Repository setup on the server

```bash
sudo apt-get update && sudo apt-get install -y nginx git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
sudo useradd --system --create-home --home-dir /opt/tekpro-document-portal tekpro
sudo -u tekpro git clone <repo-url> /opt/tekpro-document-portal/releases/<version>
cd /opt/tekpro-document-portal/releases/<version>/tekpro-document-portal
sudo -u tekpro npm ci
sudo -u tekpro npm run build
sudo -u tekpro ln -sfn "$PWD" /opt/tekpro-document-portal/current
```

(`current` must point at the `tekpro-document-portal` directory so the systemd units find `backend/`.)

## 4. Environment configuration

Create `/etc/tekpro-portal/portal.env` (owner `root`, group `tekpro`, mode `0640`) from
[`.env.example`](../.env.example). Production values:

```ini
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
LOG_LEVEL=info
DATABASE_URL=postgresql://portal_app:<password>@<db-endpoint>:5432/tekpro_portal?sslmode=require
SESSION_SECRET=<openssl rand -base64 48>
APP_BASE_URL=https://portal.tekpro.example
TRUST_PROXY=loopback
SERVE_FRONTEND_DIR=/opt/tekpro-document-portal/current/frontend/dist
STORAGE_DRIVER=s3
STORAGE_REGION=<bucket region, e.g. ap-south-1>
STORAGE_BUCKET=<bucket name>
STORAGE_ACCESS_KEY_ID=<bucket access key id>
STORAGE_SECRET_ACCESS_KEY=<bucket secret>
DOWNLOAD_URL_TTL_SECONDS=300
UPLOAD_MAX_FILE_SIZE_BYTES=5368709120
MAIL_DRIVER=smtp
MAIL_FROM=Tekpro Document Portal <no-reply@tekpro.example>
SMTP_HOST=<smtp host>
SMTP_PORT=587
SMTP_USER=<smtp user>
SMTP_PASSWORD=<smtp password>
ALLOW_ADMIN_RESET_LINKS=false
JOBS_ENABLED=false
```

The API validates this file on start and exits with a list of problems if anything is missing or
unsafe (e.g. `http://` base URL, placeholder secret, memory storage, console mailer).

## 5. PostgreSQL

1. Lightsail console → Databases → Create database → PostgreSQL 16, same region, plan as above.
   Keep **public mode disabled** so only Lightsail resources in the region can connect.
2. Connect as the master user and create an application role and database:
   ```sql
   CREATE ROLE portal_app LOGIN PASSWORD '<strong password>';
   CREATE DATABASE tekpro_portal OWNER portal_app;
   ```
3. Use `sslmode=require` in `DATABASE_URL`.

## 6. Database migrations

```bash
cd /opt/tekpro-document-portal/current/backend
sudo -u tekpro bash -c 'set -a; . /etc/tekpro-portal/portal.env; set +a; node ../node_modules/prisma/build/index.js migrate deploy'
```

Migrations are additive SQL files in `backend/prisma/migrations`; `migrate deploy` never resets data.
The migration creates the audit-log trigger, CHECK constraints and partial indexes.

## 7. Super Admin provisioning (once)

```bash
cd /opt/tekpro-document-portal/current/backend
sudo -u tekpro bash -c 'set -a; . /etc/tekpro-portal/portal.env; set +a; node dist/cli/bootstrapSuperAdmin.js --email admin@tekpro.example --name "Platform Administrator"'
```

The password is prompted (hidden). The command refuses to run if any Super Admin already exists, runs
under an advisory lock, enforces the password policy and writes an audit record. It never runs on
application start. Further administrators are created in the portal.

## 8. Lightsail Object Storage

1. Lightsail console → Storage → **Create bucket** in the same region as the instance; pick a storage plan.
2. **Bucket access permissions:** keep *All objects are private* (the default). Do not enable
   individual object access, public access or cross-account access.
3. **Permissions → Access keys → Create access key.** Store the key id and secret in
   `portal.env`. The key is scoped to this bucket. (A bucket can have two keys, which enables rotation.)
4. Note the bucket's region; the S3 endpoint is `https://s3.<region>.amazonaws.com` and the bucket
   origin used by browsers is `https://<bucket>.s3.<region>.amazonaws.com` (the API derives both;
   set `STORAGE_ENDPOINT`/`STORAGE_PUBLIC_ORIGIN` only if yours differ).
5. Optionally enable **object versioning** on the bucket for protection against accidental overwrite or
   deletion (see BACKUP_RECOVERY.md). Note that versioning retains purged objects until their noncurrent
   versions expire.

### Verify capabilities before go-live

```bash
cd /opt/tekpro-document-portal/current/backend
sudo -u tekpro bash -c 'set -a; . /etc/tekpro-portal/portal.env; set +a; node dist/cli/storageCheck.js'
```

All checks must print `PASS`: HeadBucket, pre-signed PUT, HeadObject, ranged GET, pre-signed GET with
`Content-Disposition`, **unsigned GET refused (bucket private)**, **pre-signed URL expiry**,
multipart create/upload/complete, multipart abort, delete. If multipart fails, set
`UPLOAD_MULTIPART_THRESHOLD_BYTES` ≥ `UPLOAD_MAX_FILE_SIZE_BYTES` and lower the maximum to 5 GiB
(the single-PUT limit) — files are then uploaded with one pre-signed PUT.

### Customer-owned storage (optional)

To let customers keep documents in their own AWS account, create a Tekpro IAM user whose only
permission is `sts:AssumeRole` (policy in [STORAGE_CONNECTORS.md](STORAGE_CONNECTORS.md#4-tekpro-side-configuration)),
set `CONNECTOR_AWS_ACCESS_KEY_ID` / `CONNECTOR_AWS_SECRET_ACCESS_KEY`, and set `CONNECTOR_ENCRYPTION_KEY`
(`openssl rand -base64 32`, back it up) if access-key connectors will be used. Customers deploy
[`deploy/customer-storage-role.cfn.yaml`](../deploy/customer-storage-role.cfn.yaml) in their account.

## 9. Bucket privacy and access

- No bucket policy or ACL should grant public read. The `storageCheck` "unsigned GET" test confirms it.
- The API never returns permanent URLs; downloads use 5-minute pre-signed GETs.

## 10. CORS (required for browser uploads)

Browsers upload directly to the bucket, so the bucket must allow the portal origin to `PUT` and must
**expose the `ETag` header** (needed to complete multipart uploads). Rule values
(also in [`deploy/s3-bucket-cors.json`](../deploy/s3-bucket-cors.json)):

| Setting | Value |
|---|---|
| Allowed origins | `https://portal.tekpro.example` (exactly `APP_BASE_URL`) |
| Allowed methods | `PUT`, `GET`, `HEAD` |
| Allowed headers | `*` (at least `Content-Type`) |
| Expose headers | `ETag` |
| Max age | 3000 |

Apply the rule with the CORS option Lightsail provides for buckets (Lightsail console bucket settings or
`aws lightsail update-bucket --bucket-name <bucket> --cors …` in current AWS CLI versions — check
`aws lightsail update-bucket help` for the exact syntax), or with
`aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://deploy/s3-bucket-cors.json`
if your credentials permit it. **Verify** by uploading a file through the portal in a browser:
the browser console must show no CORS errors and a multipart upload (> 100 MiB) must complete.

> If CORS cannot be configured for the bucket, direct browser uploads will not work. The portal does
> not include a server-side upload proxy fallback; use a standard S3 bucket (which supports CORS) or
> implement a streaming proxy before go-live.

Downloads do not need CORS (they are browser navigations).

## 11. Frontend build

`npm run build` produces `frontend/dist`. To show an approved logo, place it in
`frontend/public/branding/` and build with `VITE_PUBLIC_BRAND_LOGO_URL=/branding/logo.svg`. Only
`VITE_PUBLIC_*` variables reach the browser bundle.

## 12. Backend startup

```bash
sudo cp deploy/tekpro-portal.service deploy/tekpro-portal-jobs.service deploy/tekpro-portal-jobs.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tekpro-portal.service tekpro-portal-jobs.timer
```

The jobs timer runs maintenance every 15 minutes (upload expiry, purge after retention, session pruning).
Schedule reconciliation weekly, e.g. a cron entry running
`node dist/cli/runJobs.js reconcile` (report) and review before running with `--fix`.

## 13. HTTPS and domain

1. Attach a Lightsail static IP to the instance; create the DNS `A` record.
2. Open ports 80/443 in the Lightsail instance firewall; keep 3000 closed.
3. Install the Nginx site from [`deploy/nginx-tekpro-portal.conf`](../deploy/nginx-tekpro-portal.conf)
   (replace the hostname) and obtain a certificate:
   `sudo apt-get install -y certbot python3-certbot-nginx && sudo certbot --nginx -d portal.tekpro.example`.
4. The API sets HSTS, CSP and the `__Host-` Secure cookie in production; it must be reached via HTTPS.

## 14. Health checks

- `GET /api/v1/health/live` – process up.
- `GET /api/v1/health/ready` – database and storage reachable (503 otherwise).
Point an uptime monitor at `/api/v1/health/ready`.

## 15. Logs

Structured JSON on stdout → journald: `journalctl -u tekpro-portal -f`. Each line carries a request id
(also returned as `X-Request-Id` and stored in audit records). Cookies, authorization headers,
passwords, tokens and URLs are redacted; request logs exclude query strings. Ship logs to CloudWatch or
another collector if central retention is required. Audit records are in the `AuditLog` table.

## 16. Database backups

Enable automatic backups on the Lightsail database (daily snapshots + point-in-time restore, 7-day
window). Additionally take a logical dump before every deployment:
`pg_dump --format=custom "$DATABASE_URL" > tekpro-$(date +%F).dump`. See BACKUP_RECOVERY.md.

## 17. Recovery

See [BACKUP_RECOVERY.md](BACKUP_RECOVERY.md) for database restore, object recovery and reconciliation.

## 18. Application updates

```bash
NEW=/opt/tekpro-document-portal/releases/<new-version>
sudo -u tekpro git clone --branch <tag> <repo-url> $NEW
cd $NEW/tekpro-document-portal && sudo -u tekpro npm ci && sudo -u tekpro npm run build
pg_dump --format=custom "$DATABASE_URL" > /var/backups/tekpro-predeploy-$(date +%F-%H%M).dump
# apply migrations (additive), then switch the symlink and restart
sudo -u tekpro bash -c "set -a; . /etc/tekpro-portal/portal.env; set +a; cd $NEW/tekpro-document-portal/backend && node ../node_modules/prisma/build/index.js migrate deploy"
sudo -u tekpro ln -sfn $NEW/tekpro-document-portal /opt/tekpro-document-portal/current
sudo systemctl restart tekpro-portal && curl -fsS https://portal.tekpro.example/api/v1/health/ready
```

## 19. Rollback

1. Point `current` back at the previous release and `sudo systemctl restart tekpro-portal`.
2. If the new release applied a migration that the old code cannot work with, restore the pre-deploy
   dump (or use point-in-time restore to just before the deploy) **before** restarting the old code.
   Prefer backward-compatible (expand/contract) migrations so code rollback alone is sufficient.
3. Object storage needs no rollback: keys are immutable and never rewritten.

## 20. Pre-production security checklist

- [ ] `NODE_ENV=production`, HTTPS `APP_BASE_URL`, random `SESSION_SECRET`; `portal.env` mode 0640
- [ ] No `.env` or secrets in git; `ALLOW_ADMIN_RESET_LINKS=false`; `MAIL_DRIVER=smtp` working
- [ ] `storageCheck` all PASS, including *unsigned GET refused* and *URL expiry*
- [ ] Strict storage integration tests pass against a **non-production** bucket (TESTING.md)
- [ ] Browser upload (single and > 100 MiB multipart) and download verified; no CORS/CSP errors
- [ ] Database not publicly accessible; TLS enforced; backups enabled; restore rehearsed
- [ ] Port 3000 closed; only 80/443 open; SSH restricted
- [ ] First Super Admin bootstrapped; test accounts removed or deactivated
- [ ] `tests/e2e/portal-smoke.mjs` run against a staging deployment
- [ ] `npm audit` reviewed; OS packages updated; certificate auto-renewal tested
- [ ] Malware-scanning decision recorded (not included in v1)
- [ ] Rate-limit store reviewed if more than one API instance runs
