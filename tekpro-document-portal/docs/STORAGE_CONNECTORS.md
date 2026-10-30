# Customer-owned storage (storage connectors)

By default every customer's documents are stored in Tekpro's platform bucket. A **storage
connector** lets a customer keep its documents in a bucket it owns — typically in the customer's own
AWS account — while the portal keeps managing users, folders, permissions, uploads, downloads and the
audit trail exactly as before.

| | Platform storage | Customer-owned storage |
|---|---|---|
| Where files live | Tekpro's Lightsail bucket | Customer's S3 / Lightsail / S3-compatible bucket |
| Who pays for storage | Tekpro | Customer |
| Who can revoke access | Tekpro | Customer (delete the role or key at any time) |
| Portal behaviour | identical | identical (direct uploads, 5-minute download links, verification, audit) |

## 1. Connection methods

### Recommended: cross-account IAM role (Amazon S3)

The customer creates an IAM role in their account that:

- **trusts** Tekpro's AWS principal, **only** when the request carries the customer's unique
  **External ID** (protects against the "confused deputy" problem: another Tekpro customer cannot
  trick the portal into using this customer's role);
- **allows** only object operations under `customers/<customerId>/` in one bucket, and listing of that
  prefix. It cannot read or delete anything else in the bucket.

The portal calls `sts:AssumeRole` and receives **temporary credentials** (1-hour sessions, refreshed
automatically well before any pre-signed URL could outlive them). **No long-lived customer secret is
stored by Tekpro.** The customer can see every portal action in their own CloudTrail.

### Alternative: access key (Lightsail buckets, other S3-compatible services)

Lightsail buckets cannot give another AWS account write access, and non-AWS services have no IAM
roles, so these use an access key:

- **Lightsail:** Bucket → *Permissions* → *Access keys* → *Create access key* (scoped to that bucket).
- **Amazon S3 without a role:** an IAM user with the same minimal permissions policy.
- **S3-compatible** (e.g. Wasabi, Backblaze B2, Cloudflare R2, MinIO): an application key limited to the bucket.

The secret is encrypted with AES-256-GCM (`CONNECTOR_ENCRYPTION_KEY`), bound to the connector record,
never returned by the API, never logged, and replaced (not revealed) when edited.

## 2. Setting up a customer (Super Admin)

1. **Storage** (Super Admin menu) → *Connect customer storage* next to the customer (or **Customers → (customer) → Storage**).
2. Choose the storage type, bucket and region (and endpoint for S3-compatible services), choose
   *IAM role* (recommended) or *Access key*, and save. The connection is created as **Needs verification**;
   uploads for this customer are paused until it is verified (there is **no silent fallback** to Tekpro
   storage).
3. The page shows **setup instructions for the customer**: their External ID, Tekpro's AWS principal,
   and copy-ready **trust policy**, **permissions policy** and **bucket CORS rule**.
4. The customer applies them — either by hand or with the CloudFormation template
   [`deploy/customer-storage-role.cfn.yaml`](../deploy/customer-storage-role.cfn.yaml), which creates the
   role (and optionally a private, encrypted, versioned bucket with the CORS rule) and outputs the
   Role ARN.
5. Enter the Role ARN (or access key), save, and click **Verify connection**. The portal runs live checks
   against the customer's bucket with a temporary test file:

   | Check | Why |
   |---|---|
   | Credentials can access the customer folder | role/key and permissions are correct |
   | Bucket CORS allows uploads from the portal origin | browsers upload directly to the bucket |
   | Bucket CORS exposes `ETag` | needed to complete large (multipart) uploads |
   | Browser-style upload with a pre-signed URL | signing works for this bucket/region |
   | Upload verification (size) and content check (ranged read) | server-side checks before a document becomes available |
   | Download with a short-lived pre-signed URL | customer downloads work |
   | Bucket is private (unsigned request refused) | documents are never public |
   | Multipart uploads | files above 100 MiB |
   | Delete | document removal and retention purges |

   Only when **every** check passes does the connection become **Active**. Each failure shows what to fix.

From then on, **new uploads** for the customer go to their bucket. Documents uploaded earlier stay in
Tekpro storage and remain downloadable (each document remembers where it is stored).

## 3. Lifecycle rules

| Action | Rule |
|---|---|
| Edit credentials (rotate key, change role ARN) | Allowed anytime; connection returns to *Needs verification* until verified again |
| Change bucket / region / endpoint / storage type | Refused while any document is stored there (moving data between buckets is a separate migration, not done automatically) |
| Disable | Stops new uploads immediately; existing documents remain downloadable |
| Enable | Returns to *Needs verification* |
| Remove | Only when no document records reference the connector; new uploads then go to Tekpro storage |
| Create new bucket (Storage tab, or the Customer Admin's **Storage** page) | Needs the *bucket management policy* on the customer's role. Names start with `tekpro-<customer code>-`. Only when the current bucket holds no documents; the old bucket is left as it is. The new bucket is checked straight away |
| Delete bucket | Type the bucket name to confirm. Only when no documents use it and it holds nothing but the portal's own files; removes those (and their old versions), deletes the bucket and the connection |
| Customer revokes the role/key | Downloads and uploads for that customer fail with "storage temporarily unavailable"; reconciliation reports the bucket as unreachable |

All of these are recorded in the audit log (`storage_connector.*`).

**Who can create and delete buckets:** Super Admins, and a customer's own Customer Admins while the setting
*Customer admins can create and delete their storage bucket* is on (Settings → Who can do what; on by default).
Connecting the customer's AWS account in the first place (role ARN or access key) stays with Super Admins.

**Bucket management policy:** shown in the Storage tab's setup instructions for IAM-role connections. It replaces the
permissions policy and covers every bucket named `tekpro-<code>-*`: create (with the private settings), delete, and
document access only under `customers/<customerId>/`. Without it, the customer creates buckets themselves.

**Storage limit:** S3 buckets have no fixed size, so "available space" comes from an optional per-customer limit set by
a Super Admin (Storage tab → *Set a limit*). Uploads that would exceed it are refused (`STORAGE_QUOTA_EXCEEDED`).
Uploads in progress and deleted documents awaiting purge count towards it. The limit applies to platform storage too.

## 4. Tekpro-side configuration

| Variable | Purpose |
|---|---|
| `CONNECTOR_AWS_ACCESS_KEY_ID` / `CONNECTOR_AWS_SECRET_ACCESS_KEY` | Tekpro credentials used **only** to call `sts:AssumeRole`. Create a dedicated IAM user (or use an EC2 instance role and leave these unset) whose only permission is `sts:AssumeRole` on `arn:aws:iam::*:role/TekproPortalAccess*`. Its ARN is the "Tekpro AWS principal" customers trust |
| `CONNECTOR_ENCRYPTION_KEY` | 32-byte base64 key for access-key connectors (`openssl rand -base64 32`). Back it up securely: without it, stored keys cannot be decrypted |
| `CONNECTOR_STS_REGION` | STS region (default `us-east-1`) |
| `CONNECTOR_ROLE_SESSION_SECONDS` | Role session length, minimum 3600 |
| `CONNECTOR_ALLOW_INSECURE_ENDPOINTS` | Development only: allow `http://`/private endpoints. Refused in production |

Minimal policy for the Tekpro IAM user:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": "sts:AssumeRole", "Resource": "arn:aws:iam::*:role/TekproPortalAccess*" }
  ]
}
```

(If customers choose other role names, use `"Resource": "*"` — the External ID condition in each
customer's trust policy still prevents cross-customer use.)

## 5. Security notes

- Customer credentials can only touch `customers/<customerId>/` in the customer's bucket.
- Custom endpoints must be public `https://` origins (no credentials, no localhost/private/link-local
  address literals) to prevent the server being used to reach internal services (SSRF). Hostnames that
  resolve to private addresses are not detected; only Super Admins can configure connectors.
- The page Content-Security-Policy `connect-src` includes only the origins of configured connector
  buckets.
- Bucket versioning (recommended, enabled by the CloudFormation template) means that when the portal
  purges a deleted document, the customer still holds a noncurrent version under their own retention
  rules.
- Default bucket encryption (SSE-S3) works with no extra permissions. If the customer uses SSE-KMS with
  their own key, add `kms:GenerateDataKey` and `kms:Decrypt` on that key to the role's permissions.

## 6. Trying it locally

`npm run setup:dev` configures local STS and a second bucket, `customer-demo`, on the moto server. In the
portal: Storage tab → *Other S3-compatible storage*, endpoint `http://localhost:5050`, path-style on,
bucket `customer-demo`, region `us-east-1`, IAM role, any role ARN such as
`arn:aws:iam::123456789012:role/TekproPortalAccess` → Save → Verify connection.

## 7. Operations

- `npm run jobs -- reconcile` scans the platform bucket **and** every customer bucket (customer prefix
  only), reporting orphans, stray objects, missing objects, **misplaced** objects (found in a bucket other
  than the one their document record names — never deleted automatically) and unreachable buckets.
- Maintenance jobs (upload expiry, purge after retention) act on whichever bucket each document lives in.
