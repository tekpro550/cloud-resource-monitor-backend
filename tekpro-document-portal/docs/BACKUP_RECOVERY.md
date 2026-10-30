# Backup and Recovery

The portal stores state in two systems that must be considered together:

| Data | System | Loss impact |
|---|---|---|
| Users, customers, folders, permissions, document metadata, audit log | PostgreSQL | Without it, objects cannot be attributed to customers or authorised |
| Document bytes | Lightsail bucket | Without it, metadata points to nothing (`MISSING_OBJECT`) |

## 1. Database backups

1. **Automatic backups** (Lightsail managed database): daily snapshots plus point-in-time restore within
   the retention window. Enable on creation; verify in the console.
2. **Logical dumps** before every deployment and at least weekly, stored outside the database host
   (e.g. a separate, private backup bucket with versioning):
   ```bash
   pg_dump --format=custom --no-owner "$DATABASE_URL" > tekpro-$(date +%F).dump
   ```
3. Dumps contain password hashes, session hashes and audit data: store them encrypted with restricted
   access, and apply the same retention policy as the audit log.

## 2. Object storage

- Objects are written once under immutable keys (`customers/{customerId}/documents/{documentId}`) and
  are only deleted by the purge job after the retention period (`DELETED_DOCUMENT_RETENTION_DAYS`,
  default 30) or by reconciliation of orphans.
- **Soft delete** is the first line of recovery: deleted documents stay restorable from the UI
  ("Recently deleted" view → Restore) until purged.
- For protection beyond retention, enable **bucket object versioning** in Lightsail. A purged object
  then remains as a noncurrent version that an administrator can restore with the S3 API. Versioning
  increases storage usage; define how long noncurrent versions are kept.
- For disaster recovery across regions, periodically copy the bucket to a second bucket/region
  (e.g. `aws s3 sync s3://<bucket> s3://<dr-bucket>` with appropriate credentials).

## 3. Recovery procedures

### 3.1 Restore the database to a point in time

1. Stop the API: `sudo systemctl stop tekpro-portal tekpro-portal-jobs.timer`.
2. Restore via Lightsail (point-in-time restore creates a new database) or `pg_restore`:
   ```bash
   pg_restore --clean --if-exists --no-owner --dbname "$DATABASE_URL" tekpro-YYYY-MM-DD.dump
   ```
   The audit-log trigger blocks `TRUNCATE/DELETE` of audit rows; `--clean` on a fresh, empty database
   avoids this. When restoring over an existing database, restore into a new database and switch
   `DATABASE_URL`.
3. Run `migrate deploy` (no-op if already current).
4. Run reconciliation in **report** mode: `node dist/cli/runJobs.js reconcile`.
   - Objects uploaded after the restore point appear as **orphans** (no record). Decide whether to
     re-register them (re-upload through the portal) or let `--fix` delete them.
   - Documents deleted/purged after the restore point appear as **missing objects**; `--fix` marks
     them `MISSING_OBJECT` so customers no longer see broken entries.
5. Start the API and timer; verify `/api/v1/health/ready`.

### 3.2 Recover an individual deleted document

- Within retention: Tekpro staff → customer → Documents → status filter *Recently deleted* → Restore.
- After purge with versioning enabled: restore the noncurrent object version with the S3 API, then set
  the document back to `DELETED` in the database and restore it from the UI (or re-upload it).

### 3.3 Recover from lost/compromised storage credentials

Create a new bucket access key, update `portal.env`, restart, run `storageCheck`, then delete the old key.
Pre-signed URLs signed with the old key stop working when it is deleted.

### 3.4 Recover from a lost bucket

Restore objects from the DR copy into a bucket with the same name/region (or update `STORAGE_BUCKET`),
reconfigure CORS, run `storageCheck`, then `reconcile` to identify any documents without objects.

## 4. Reconciliation

`node dist/cli/runJobs.js reconcile` lists:

- `orphanObjects` – objects older than 24 h with no document record;
- `strayObjects` – objects whose document is `PURGED` or `UPLOAD_FAILED`;
- `missingObjects` – `AVAILABLE` documents whose object does not exist.

`--fix` deletes orphan/stray objects and marks missing documents `MISSING_OBJECT`; every change is
audited (`storage.orphan_removed`, `document.object_missing`). Run report mode first and review.

## 5. Audit log retention

The `AuditLog` table is append-only (database trigger). To apply a retention policy, a DBA must
explicitly and temporarily disable the trigger inside a maintenance transaction:

```sql
BEGIN;
ALTER TABLE "AuditLog" DISABLE TRIGGER "AuditLog_no_delete";
DELETE FROM "AuditLog" WHERE "createdAt" < now() - interval '2 years';
ALTER TABLE "AuditLog" ENABLE TRIGGER "AuditLog_no_delete";
COMMIT;
```

Export records before deleting them if they must be archived.

## 6. Test the procedures

Rehearse 3.1 against a staging copy at least quarterly and after major upgrades; record the time taken
(recovery time) and the restore point achieved (recovery point).
