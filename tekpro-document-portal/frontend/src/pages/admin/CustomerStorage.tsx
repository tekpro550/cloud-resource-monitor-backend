import { useState, type FormEvent } from "react";
import { Alert, Badge, Button, Card, ConfirmDialog, ErrorState, Field, Input, Select, Spinner } from "../../components/ui";
import { useAsync } from "../../hooks/useAsync";
import { errorMessage } from "../../services/api";
import { storageConnectorApi } from "../../services/endpoints";
import type { ConnectorInput, ConnectorStatus, StorageAuthType, StorageConnector, StorageProvider, VerificationResult } from "../../types/api";
import { formatDateTime } from "../../utils/format";

export const STATUS: Record<ConnectorStatus, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  ACTIVE: { label: "Active", tone: "success" },
  PENDING_VERIFICATION: { label: "Needs verification", tone: "warning" },
  FAILED: { label: "Verification failed", tone: "danger" },
  DISABLED: { label: "Disabled", tone: "neutral" },
};

export const PROVIDERS: { id: StorageProvider; label: string }[] = [
  { id: "AWS_S3", label: "Amazon S3 (customer's AWS account)" },
  { id: "LIGHTSAIL", label: "Amazon Lightsail bucket (customer's account)" },
  { id: "S3_COMPATIBLE", label: "Other S3-compatible storage" },
];

function CopyBlock({ title, value }: { title: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <div className="copy-block">
      <div className="copy-block-head">
        <strong>{title}</strong>
        <Button
          size="sm"
          variant="ghost"
          onClick={async () => {
            await navigator.clipboard?.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre>{text}</pre>
    </div>
  );
}

function Checklist({ result }: { result: VerificationResult }) {
  return (
    <ul className="checklist" aria-label="Verification results">
      {result.checks.map((c) => (
        <li key={c.id} className={c.ok ? "check-ok" : "check-fail"}>
          <span aria-hidden="true">{c.ok ? "✓" : "✗"}</span>
          <span>
            {c.label}
            {c.detail && <span className="doc-desc">{c.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ConnectorForm({ customerId, existing, onSaved, onCancel }: { customerId: string; existing: StorageConnector | null; onSaved: () => void; onCancel?: () => void }) {
  const [provider, setProvider] = useState<StorageProvider>(existing?.provider ?? "AWS_S3");
  const [authType, setAuthType] = useState<StorageAuthType>(existing?.authType ?? "ASSUME_ROLE");
  const [bucket, setBucket] = useState(existing?.bucket ?? "");
  const [region, setRegion] = useState(existing?.region ?? "ap-south-1");
  const [endpoint, setEndpoint] = useState(existing?.endpoint ?? "");
  const [pathStyle, setPathStyle] = useState(existing?.forcePathStyle ?? false);
  const [roleArn, setRoleArn] = useState(existing?.roleArn ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const effectiveAuth: StorageAuthType = provider === "LIGHTSAIL" ? "ACCESS_KEY" : authType;
  const locked = (existing?.documentCount ?? 0) > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const body: ConnectorInput = {
      provider,
      bucket: bucket.trim(),
      region: region.trim(),
      authType: effectiveAuth,
      ...(provider === "S3_COMPATIBLE" ? { endpoint: endpoint.trim(), forcePathStyle: pathStyle } : {}),
      ...(effectiveAuth === "ASSUME_ROLE"
        ? { roleArn: roleArn.trim() }
        : { accessKeyId: accessKeyId.trim() || undefined, secretAccessKey: secret || undefined }),
    };
    try {
      await storageConnectorApi.save(customerId, body);
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="form" onSubmit={submit}>
      {locked && <Alert kind="info">Documents are stored in this bucket, so its location cannot change. You can update the credentials.</Alert>}
      <Field label="Storage type">
        {(id) => (
          <Select id={id} value={provider} disabled={locked} onChange={(e) => setProvider(e.target.value as StorageProvider)}>
            {PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <div className="grid-2-tight">
        <Field label="Bucket name">{(id) => <Input id={id} value={bucket} disabled={locked} onChange={(e) => setBucket(e.target.value)} placeholder="antrix-tekpro-documents" />}</Field>
        <Field label="Region">{(id) => <Input id={id} value={region} disabled={locked} onChange={(e) => setRegion(e.target.value)} placeholder="ap-south-1" />}</Field>
      </div>
      {provider === "S3_COMPATIBLE" && (
        <>
          <Field label="Endpoint" hint="HTTPS origin of the S3-compatible service, e.g. https://s3.eu-central-1.wasabisys.com">
            {(id, d) => <Input id={id} aria-describedby={d} value={endpoint} disabled={locked} onChange={(e) => setEndpoint(e.target.value)} />}
          </Field>
          <label className="checkbox">
            <input type="checkbox" checked={pathStyle} disabled={locked} onChange={(e) => setPathStyle(e.target.checked)} />
            Use path-style URLs (required by some providers)
          </label>
        </>
      )}
      {provider !== "LIGHTSAIL" && (
        <Field label="How the portal connects">
          {(id) => (
            <Select id={id} value={authType} onChange={(e) => setAuthType(e.target.value as StorageAuthType)}>
              <option value="ASSUME_ROLE">IAM role in the customer's account (recommended)</option>
              <option value="ACCESS_KEY">Access key</option>
            </Select>
          )}
        </Field>
      )}
      {effectiveAuth === "ASSUME_ROLE" ? (
        <Field label="Role ARN" hint="Created by the customer using the trust and permissions policies shown after saving.">
          {(id, d) => <Input id={id} aria-describedby={d} value={roleArn} onChange={(e) => setRoleArn(e.target.value)} placeholder="arn:aws:iam::123456789012:role/TekproPortalAccess" />}
        </Field>
      ) : (
        <div className="grid-2-tight">
          <Field label="Access key ID" hint={existing?.accessKeyIdMasked ? `Current: ${existing.accessKeyIdMasked}` : undefined}>
            {(id, d) => <Input id={id} aria-describedby={d} value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} autoComplete="off" />}
          </Field>
          <Field label="Secret access key" hint={existing?.secretStored ? "Leave empty to keep the stored secret" : "Stored encrypted; never shown again"}>
            {(id, d) => <Input id={id} aria-describedby={d} type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" />}
          </Field>
        </div>
      )}
      {error ? <Alert kind="error">{errorMessage(error)}</Alert> : null}
      <div className="row-actions">
        {onCancel && <Button onClick={onCancel}>Cancel</Button>}
        <Button type="submit" variant="primary" loading={busy}>
          Save connection
        </Button>
      </div>
      <p className="muted small">Saving always requires a new verification before uploads use this storage.</p>
    </form>
  );
}

/** Super Admin: choose where this customer's documents are stored. */
export function CustomerStorage({ customerId }: { customerId: string }) {
  const view = useAsync(() => storageConnectorApi.get(customerId), [customerId]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [lastResult, setLastResult] = useState<VerificationResult | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  if (view.loading && !view.data) return <Spinner />;
  if (view.error) return <ErrorState error={view.error} onRetry={view.reload} />;
  const { connector, setup, portalPrincipalArn, portalIdentityError } = view.data!;

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setActionError(null);
    try {
      await fn();
      view.reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(null);
    }
  };

  if (!connector || editing) {
    return (
      <Card title={connector ? "Edit storage connection" : "Document storage"}>
        {!connector && (
          <p>
            This customer's documents are stored in <strong>Tekpro platform storage</strong>. To keep them in a bucket the customer owns (for example in their own AWS
            account), connect it here. New uploads will go to that bucket once the connection is verified; existing documents stay where they are.
          </p>
        )}
        <ConnectorForm
          customerId={customerId}
          existing={connector}
          onSaved={() => {
            setEditing(false);
            setLastResult(null);
            view.reload();
          }}
          onCancel={connector ? () => setEditing(false) : undefined}
        />
      </Card>
    );
  }

  const status = STATUS[connector.status];
  const result = lastResult ?? connector.lastCheck;
  return (
    <>
      <Card
        title={
          <>
            Customer-owned storage <Badge tone={status.tone}>{status.label}</Badge>
          </>
        }
        actions={
          <div className="row-actions">
            <Button variant="primary" size="sm" loading={busy === "verify"} onClick={() => act("verify", async () => setLastResult((await storageConnectorApi.verify(customerId)).result))}>
              Verify connection
            </Button>
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit
            </Button>
            {connector.status === "DISABLED" ? (
              <Button size="sm" loading={busy === "enable"} onClick={() => act("enable", () => storageConnectorApi.enable(customerId))}>
                Enable
              </Button>
            ) : (
              <Button size="sm" loading={busy === "disable"} onClick={() => act("disable", () => storageConnectorApi.disable(customerId))}>
                Disable
              </Button>
            )}
            <Button size="sm" variant="ghost" className="text-danger" onClick={() => setConfirmRemove(true)}>
              Remove
            </Button>
          </div>
        }
      >
        {connector.status !== "ACTIVE" && (
          <Alert kind="warning">Uploads for this customer are paused until the connection is verified and active. Existing documents remain downloadable.</Alert>
        )}
        {actionError ? <Alert kind="error">{errorMessage(actionError)}</Alert> : null}
        <dl className="details">
          <dt>Storage</dt>
          <dd>{PROVIDERS.find((p) => p.id === connector.provider)?.label}</dd>
          <dt>Bucket</dt>
          <dd>
            {connector.bucket} ({connector.region}){connector.endpoint ? ` at ${connector.endpoint}` : ""}
          </dd>
          <dt>Folder used</dt>
          <dd>
            <code>{connector.prefix}</code>
          </dd>
          <dt>Connection</dt>
          <dd>{connector.authType === "ASSUME_ROLE" ? `IAM role ${connector.roleArn}` : `Access key ${connector.accessKeyIdMasked}`}</dd>
          <dt>Documents stored</dt>
          <dd>{connector.documentCount}</dd>
          <dt>Last verified</dt>
          <dd>{formatDateTime(connector.lastVerifiedAt)}</dd>
        </dl>
        {result && (
          <>
            <h3 className="section-title">Verification {result.ok ? "passed" : "failed"} · {formatDateTime(result.checkedAt)}</h3>
            <Checklist result={result} />
          </>
        )}
      </Card>

      {setup && (
        <Card title="Setup instructions for the customer">
          {connector.authType === "ASSUME_ROLE" ? (
            <>
              <p>Send these to the customer's AWS administrator. In their AWS account they:</p>
              <ol className="steps">
                <li>
                  Create an IAM role (for example <code>TekproPortalAccess</code>) with the <strong>trust policy</strong> below. It only lets the Tekpro portal assume the role
                  when it presents this customer's External ID.
                </li>
                <li>
                  Attach the <strong>permissions policy</strong> below. It only allows access to <code>{connector.prefix}</code> in bucket <code>{connector.bucket}</code>.
                </li>
                <li>
                  Add the <strong>CORS rule</strong> to the bucket and keep <em>Block all public access</em> enabled.
                </li>
                <li>Send the role ARN back to Tekpro, enter it above, and click "Verify connection".</li>
              </ol>
              <dl className="details">
                <dt>External ID</dt>
                <dd>
                  <code>{connector.externalId}</code>
                </dd>
                <dt>Tekpro AWS principal</dt>
                <dd>{portalPrincipalArn ? <code>{portalPrincipalArn}</code> : <span className="text-danger">{portalIdentityError}</span>}</dd>
              </dl>
              {setup.trustPolicy && <CopyBlock title="Trust policy" value={setup.trustPolicy} />}
            </>
          ) : (
            <p>
              Ask the customer for an access key that can only reach this bucket (for Lightsail: <em>bucket → Permissions → Access keys</em>), and add the CORS rule
              below to the bucket. Keep the bucket private.
            </p>
          )}
          <CopyBlock title={connector.authType === "ASSUME_ROLE" ? "Permissions policy" : "Minimum permissions (for an IAM user, if not Lightsail)"} value={setup.permissionsPolicy} />
          <CopyBlock title="Bucket CORS rule" value={setup.corsConfiguration} />
        </Card>
      )}

      {confirmRemove && (
        <ConfirmDialog
          title="Remove storage connection"
          danger
          confirmLabel="Remove"
          busy={busy === "remove"}
          error={actionError}
          message={
            connector.documentCount > 0
              ? `${connector.documentCount} document(s) are stored in this bucket, so the connection cannot be removed. Disable it instead to stop new uploads.`
              : "New uploads for this customer will go to Tekpro platform storage again."
          }
          confirmDisabled={connector.documentCount > 0}
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() =>
            act("remove", async () => {
              await storageConnectorApi.remove(customerId);
              setConfirmRemove(false);
            })
          }
        />
      )}
    </>
  );
}
