import { useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorState, Field, Input, PageHeader, Spinner } from "../../components/ui";
import { useAsync } from "../../hooks/useAsync";
import { useCurrentUser } from "../../hooks/useAuth";
import { CustomerStorage, PROVIDERS, STATUS } from "../../pages/admin/CustomerStorage";
import { errorMessage } from "../../services/api";
import { customersApi, storageConnectorApi } from "../../services/endpoints";
import type { StorageUsage, VerificationResult } from "../../types/api";
import { formatBytes } from "../../utils/format";

const GB = 1024 ** 3;

/** Used / limit / available space, with the limit editable by the Super Admin. */
export function StorageUsageCard({ customerId, usage, canEditLimit, onChanged }: { customerId: string; usage: StorageUsage; canEditLimit: boolean; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [limitGb, setLimitGb] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const { usedBytes, quotaBytes, availableBytes } = usage;
  const percent = quotaBytes ? Math.min(100, (usedBytes / quotaBytes) * 100) : 0;

  const save = async (value: number | null) => {
    setBusy(true);
    setError(null);
    try {
      await customersApi.update(customerId, { storageQuotaBytes: value });
      setEditing(false);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const gb = Number(limitGb);
    if (!Number.isFinite(gb) || gb <= 0) return setError(new Error("Enter a storage limit greater than 0 GB"));
    void save(Math.round(gb * GB));
  };

  return (
    <Card
      title="Storage space"
      actions={
        canEditLimit && !editing ? (
          <Button
            size="sm"
            onClick={() => {
              setLimitGb(quotaBytes ? String(Math.round((quotaBytes / GB) * 100) / 100) : "");
              setEditing(true);
            }}
          >
            {quotaBytes ? "Change limit" : "Set a limit"}
          </Button>
        ) : undefined
      }
    >
      <div className="stats-grid">
        <div className="stat">
          <span className="stat-label">Used</span>
          <span className="stat-value">{formatBytes(usedBytes)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Limit</span>
          <span className="stat-value">{quotaBytes ? formatBytes(quotaBytes) : "No limit"}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Available</span>
          <span className="stat-value">{availableBytes === null ? "Unlimited" : formatBytes(availableBytes)}</span>
        </div>
      </div>
      {quotaBytes ? (
        <div className="progress" role="progressbar" aria-label="Storage used" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100}>
          <div className={`progress-bar ${percent >= 90 ? "progress-bar-danger" : ""}`} style={{ width: `${percent}%` }} />
        </div>
      ) : null}
      <p className="muted small">
        {usage.documents.count} documents ({formatBytes(usage.documents.bytes)})
        {usage.deletedPendingPurge.count ? ` · ${usage.deletedPendingPurge.count} deleted, kept until purged (${formatBytes(usage.deletedPendingPurge.bytes)})` : ""}
        {usage.uploading.count ? ` · ${usage.uploading.count} uploading (${formatBytes(usage.uploading.bytes)})` : ""}
        {!quotaBytes && usage.location.mode === "CUSTOMER" ? " · Amazon S3 has no fixed capacity; set a limit to control growth." : ""}
      </p>
      {editing && (
        <form className="form" onSubmit={submit}>
          <Field label="Storage limit (GB)" hint="Uploads that would go over the limit are refused. Deleted documents count until they are purged.">
            {(id, describedBy) => (
              <Input id={id} aria-describedby={describedBy} type="number" min="0.01" step="any" required value={limitGb} onChange={(e) => setLimitGb(e.target.value)} />
            )}
          </Field>
          <div className="row-actions">
            <Button type="submit" variant="primary" loading={busy}>
              Save limit
            </Button>
            {quotaBytes ? (
              <Button onClick={() => void save(null)} disabled={busy}>
                Remove limit
              </Button>
            ) : null}
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {error ? <Alert kind="error">{errorMessage(error)}</Alert> : null}
    </Card>
  );
}

/** Where documents are stored, and creating/deleting the customer's own bucket. */
export function BucketCard({ customerId, usage, onChanged, ownOrganisation = false }: { customerId: string; usage: StorageUsage; onChanged: () => void; ownOrganisation?: boolean }) {
  const { location, bucketManagement: m } = usage;
  const [creating, setCreating] = useState(false);
  const [suffix, setSuffix] = useState("");
  const [region, setRegion] = useState(location.mode === "CUSTOMER" ? location.region : "ap-south-1");
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<VerificationResult | null>(null);
  const canManage = m.allowed && m.available;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await storageConnectorApi.createBucket(customerId, { bucket: `${m.bucketPrefix}${suffix.trim().toLowerCase()}`, region: region.trim() });
      setResult(res.result);
      setCreating(false);
      setSuffix("");
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (location.mode !== "CUSTOMER") return;
    setBusy(true);
    setError(null);
    try {
      await storageConnectorApi.deleteBucket(customerId, confirmName.trim());
      setDeleting(false);
      setConfirmName("");
      setResult(null);
      onChanged();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const status = location.mode === "CUSTOMER" ? STATUS[location.status] : null;
  return (
    <Card
      title="Storage bucket"
      actions={
        canManage && !creating ? (
          <div className="row-actions">
            <Button size="sm" variant="primary" onClick={() => setCreating(true)} disabled={m.documentsInBucket > 0}>
              Create new bucket
            </Button>
            {location.mode === "CUSTOMER" && (
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDeleting(true)} disabled={m.documentsInBucket > 0}>
                Delete bucket
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {location.mode === "PLATFORM" ? (
        <p>
          Documents are stored in <strong>Tekpro platform storage</strong>.
          {m.allowed
            ? ownOrganisation
              ? " To store them in your own AWS account, a Tekpro Super Admin first connects the account; buckets can then be created here."
              : " To store them in the customer's own AWS account, connect it below (Connect customer storage); buckets can then be created here."
            : ""}
        </p>
      ) : (
        <dl className="details">
          <dt>Stored in</dt>
          <dd>{PROVIDERS.find((p) => p.id === location.provider)?.label ?? location.provider}</dd>
          <dt>Bucket</dt>
          <dd>
            <code>{location.bucket}</code> ({location.region})
          </dd>
          <dt>Status</dt>
          <dd>{status && <Badge tone={status.tone}>{status.label}</Badge>}</dd>
          <dt>Documents in this bucket</dt>
          <dd>{m.documentsInBucket}</dd>
        </dl>
      )}
      {canManage && m.documentsInBucket > 0 && (
        <p className="muted small">This bucket holds documents, so it cannot be replaced or deleted. Documents are never moved between buckets automatically.</p>
      )}
      {m.allowed && location.mode === "CUSTOMER" && !m.available && (
        <p className="muted small">Lightsail buckets are created and deleted in the Lightsail console.</p>
      )}
      {creating && (
        <form className="form" onSubmit={create}>
          <p className="muted small">
            The bucket is created in the customer's own AWS account: private (all public access blocked), encrypted, with versioning and the browser upload
            rule. New uploads go to it once its checks pass.
            {location.mode === "CUSTOMER" ? ` It replaces "${location.bucket}", which is not deleted.` : ""}
          </p>
          <Field label="Bucket name" hint={`Names start with "${m.bucketPrefix}" and use lower-case letters, digits and hyphens. They must be unique across all of AWS.`}>
            {(id, describedBy) => (
              <div className="input-prefix">
                <span aria-hidden="true">{m.bucketPrefix}</span>
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  required
                  pattern="[a-z0-9][a-z0-9\-]*[a-z0-9]|[a-z0-9]"
                  maxLength={63 - m.bucketPrefix.length}
                  placeholder="documents"
                  value={suffix}
                  onChange={(e) => setSuffix(e.target.value.toLowerCase())}
                />
              </div>
            )}
          </Field>
          <Field label="AWS region" hint="For example ap-south-1 (Mumbai), eu-west-1 (Ireland), us-east-1 (N. Virginia).">
            {(id, describedBy) => <Input id={id} aria-describedby={describedBy} required value={region} onChange={(e) => setRegion(e.target.value)} />}
          </Field>
          <div className="row-actions">
            <Button type="submit" variant="primary" loading={busy}>
              Create bucket
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {result && (
        <Alert kind={result.ok ? "success" : "warning"}>
          {result.ok
            ? "Bucket created and all checks passed. New uploads now go to this bucket."
            : `Bucket created, but some checks failed: ${result.checks.filter((c) => !c.ok).map((c) => c.label).join(", ")}. Uploads stay paused until a Super Admin verifies the connection.`}
        </Alert>
      )}
      {error && !deleting ? <Alert kind="error">{errorMessage(error)}</Alert> : null}
      {deleting && location.mode === "CUSTOMER" && (
        <ConfirmDialog
          title="Delete storage bucket"
          danger
          confirmLabel="Delete bucket"
          busy={busy}
          error={error}
          confirmDisabled={confirmName.trim() !== location.bucket}
          message={
            <>
              This permanently deletes the bucket <strong>{location.bucket}</strong> from the customer's AWS account, including the portal's test files and old
              file versions. It only works when the bucket holds no documents and no files from outside the portal. New uploads then go to Tekpro platform storage.
            </>
          }
          onCancel={() => {
            setDeleting(false);
            setError(null);
          }}
          onConfirm={() => void remove()}
        >
          <Field label={`Type ${location.bucket} to confirm`}>
            {(id) => <Input id={id} autoComplete="off" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />}
          </Field>
        </ConfirmDialog>
      )}
    </Card>
  );
}

/** Super Admin customer page, Storage tab: space, bucket, and the connection to the customer's account. */
export function CustomerStorageTab({ customerId }: { customerId: string }) {
  const usage = useAsync(() => customersApi.storageUsage(customerId), [customerId]);
  const [version, setVersion] = useState(0);
  if (usage.loading && !usage.data) return <Spinner />;
  if (usage.error) return <ErrorState error={usage.error} onRetry={usage.reload} />;
  const changed = () => {
    usage.reload();
    setVersion((v) => v + 1);
  };
  return (
    <>
      <StorageUsageCard customerId={customerId} usage={usage.data!} canEditLimit onChanged={changed} />
      <BucketCard customerId={customerId} usage={usage.data!} onChanged={changed} />
      <CustomerStorage key={version} customerId={customerId} onChanged={usage.reload} />
    </>
  );
}

/** Customer Admin: their organisation's storage space and bucket. */
export function OrganisationStoragePage() {
  const user = useCurrentUser();
  const customerId = user.customerId!;
  const usage = useAsync(() => customersApi.storageUsage(customerId), [customerId]);
  if (usage.loading && !usage.data) return <Spinner />;
  if (usage.error) return <ErrorState error={usage.error} onRetry={usage.reload} />;
  return (
    <>
      <PageHeader title="Storage" subtitle="Space used by your organisation's documents, and where they are stored" />
      <StorageUsageCard customerId={customerId} usage={usage.data!} canEditLimit={false} onChanged={usage.reload} />
      <BucketCard customerId={customerId} usage={usage.data!} onChanged={usage.reload} ownOrganisation />
    </>
  );
}
