import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Alert, Badge, Button, Card, ErrorState, Field, Input, PageHeader, Spinner, StatTile } from "../../components/ui";
import { useAsync } from "../../hooks/useAsync";
import { useAuth, useCurrentUser } from "../../hooks/useAuth";
import { errorMessage } from "../../services/api";
import { authApi, settingsApi, statsApi } from "../../services/endpoints";
import type { PortalSettings } from "../../types/api";
import { formatBytes, formatDate, ROLE_LABELS } from "../../utils/format";
import { PASSWORD_HINT } from "../auth/PasswordPages";
import { PROVIDERS, STATUS } from "./CustomerStorage";

export function StoragePage() {
  const stats = useAsync(() => statsApi.storage(), []);
  if (stats.loading) return <Spinner />;
  if (stats.error) return <ErrorState error={stats.error} onRetry={stats.reload} />;
  const { customers, dailyUploads } = stats.data!;
  const total = customers.reduce((n, c) => n + (c.byStatus.AVAILABLE?.bytes ?? 0), 0);
  const retained = customers.reduce((n, c) => n + (c.byStatus.DELETED?.bytes ?? 0), 0);
  const last30 = dailyUploads.reduce((n, d) => n + d.bytes, 0);
  const peak = Math.max(1, ...dailyUploads.map((d) => d.bytes));
  return (
    <>
      <PageHeader title="Storage" subtitle="Where each customer's documents are stored, and usage recorded in the portal database" />
      <Card title="Document storage by customer">
        <p className="muted small">
          Documents use Tekpro platform storage unless a customer has its own storage connected, for example a bucket in the customer's own AWS account
          (cross-account IAM role) or Lightsail bucket.
        </p>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Stored in</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => {
                const k = c.storageConnector;
                const status = k ? STATUS[k.status] : null;
                return (
                  <tr key={c.id}>
                    <td data-label="Customer">
                      <strong>{c.name}</strong> <span className="muted small">{c.customerCode}</span>
                    </td>
                    <td data-label="Stored in">
                      {k ? (
                        <>
                          {PROVIDERS.find((p) => p.id === k.provider)?.label ?? k.provider}
                          <span className="doc-desc">
                            {k.bucket} · {k.region} · {k.authType === "ASSUME_ROLE" ? "IAM role" : "access key"}
                          </span>
                        </>
                      ) : (
                        "Tekpro platform storage"
                      )}
                    </td>
                    <td data-label="Status">{status ? <Badge tone={status.tone}>{status.label}</Badge> : <span className="muted">Default</span>}</td>
                    <td data-label="Actions">
                      <Link className="btn btn-secondary btn-sm" to={`/customers/${c.id}?tab=storage`}>
                        {k ? "Manage" : "Connect customer storage"}
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {customers.length === 0 && <p className="muted">No customers yet. Create a customer first, then connect its storage here.</p>}
      </Card>
      <div className="stats-grid">
        <StatTile label="Active documents" value={formatBytes(total)} />
        <StatTile label="Deleted, pending purge" value={formatBytes(retained)} />
        <StatTile label="Uploaded (30 days)" value={formatBytes(last30)} hint={`≈ ${formatBytes(last30 / 30)} per day`} />
      </div>
      <Card title="Daily uploads (last 30 days)">
        {dailyUploads.length ? (
          <ul className="bar-chart" aria-label="Daily upload volume">
            {dailyUploads.map((d) => (
              <li key={d.day}>
                <span className="bar-label">{formatDate(d.day)}</span>
                <span className="bar-track">
                  <span className="bar-fill" style={{ width: `${(d.bytes / peak) * 100}%` }} />
                </span>
                <span className="bar-value">
                  {formatBytes(d.bytes)} · {d.uploads} files
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">No uploads in the last 30 days.</p>
        )}
      </Card>
      <Card title="By customer">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Customer</th>
                <th scope="col">Available</th>
                <th scope="col">Deleted (recoverable)</th>
                <th scope="col">Failed / missing</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id}>
                  <td data-label="Customer">
                    <strong>{c.name}</strong> <span className="muted small">{c.customerCode}</span>
                  </td>
                  <td data-label="Available">
                    {c.byStatus.AVAILABLE?.count ?? 0} · {formatBytes(c.byStatus.AVAILABLE?.bytes ?? 0)}
                  </td>
                  <td data-label="Deleted">
                    {c.byStatus.DELETED?.count ?? 0} · {formatBytes(c.byStatus.DELETED?.bytes ?? 0)}
                  </td>
                  <td data-label="Failed / missing">{(c.byStatus.UPLOAD_FAILED?.count ?? 0) + (c.byStatus.MISSING_OBJECT?.count ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}

const SETTING_LABELS: Record<keyof PortalSettings, { label: string; hint: string }> = {
  staffAuditAccess: { label: "Tekpro Users can view activity of assigned customers", hint: "Audit records limited to customers assigned to each user." },
  staffCanDeleteDocuments: { label: "Tekpro Users can delete documents", hint: "When off, only the Super Admin can delete documents." },
  staffCanDeleteFolders: { label: "Tekpro Users can delete folders", hint: "When off, only the Super Admin can delete folders." },
  customerAdminActivityAccess: { label: "Customer Admins can view their organisation's activity", hint: "Downloads and sign-ins by users of their own organisation." },
  customerUserActivityAccess: { label: "Customer Users can view their own activity", hint: "Their own downloads and sign-ins." },
};

export function SettingsPage() {
  const data = useAsync(() => settingsApi.get(), []);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  const { settings, configuration } = data.data!;

  const toggle = async (key: keyof PortalSettings, value: boolean) => {
    setSaving(key);
    setError(null);
    try {
      data.setData(await settingsApi.update({ [key]: value }));
    } catch (err) {
      setError(err);
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <PageHeader title="System settings" subtitle="Changes are recorded in the audit log" />
      {error ? <Alert kind="error">{errorMessage(error)}</Alert> : null}
      <Card title="Access policy">
        <ul className="settings-list">
          {(Object.keys(SETTING_LABELS) as (keyof PortalSettings)[]).map((key) => (
            <li key={key}>
              <label className="switch-row">
                <input type="checkbox" checked={settings[key]} disabled={saving === key} onChange={(e) => toggle(key, e.target.checked)} />
                <span>
                  <span className="switch-label">{SETTING_LABELS[key].label}</span>
                  <span className="muted small">{SETTING_LABELS[key].hint}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Deployment configuration (read-only)">
        <p className="muted small">These values come from the server environment and are changed by redeploying with new configuration.</p>
        <dl className="details">
          {Object.entries(configuration).map(([k, v]) => (
            <div key={k} className="details-row">
              <dt>{k}</dt>
              <dd>{typeof v === "number" && /Bytes$/.test(k) ? formatBytes(v) : Array.isArray(v) ? v.join(", ") : String(v)}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </>
  );
}

export function AccountPage() {
  const user = useCurrentUser();
  const { applySession } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (next !== confirm) return setMessage({ kind: "error", text: "The new passwords do not match." });
    setBusy(true);
    setMessage(null);
    try {
      applySession(await authApi.changePassword(current, next));
      setCurrent("");
      setNext("");
      setConfirm("");
      setMessage({ kind: "success", text: "Password changed. Other sessions have been signed out." });
    } catch (err) {
      setMessage({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader title="My account" />
      <div className="grid-2">
        <Card title="Profile">
          <dl className="details">
            <dt>Name</dt>
            <dd>{user.fullName}</dd>
            <dt>Email</dt>
            <dd>{user.email}</dd>
            <dt>Role</dt>
            <dd>{ROLE_LABELS[user.role]}</dd>
            {user.customer && (
              <>
                <dt>Organisation</dt>
                <dd>{user.customer.name}</dd>
              </>
            )}
          </dl>
          <p className="muted small">Contact your Tekpro administrator to change your name, email or role.</p>
        </Card>
        <Card title="Change password">
          <form className="form" onSubmit={submit}>
            {message && <Alert kind={message.kind}>{message.text}</Alert>}
            <Field label="Current password">{(id) => <Input id={id} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />}</Field>
            <Field label="New password" hint={PASSWORD_HINT}>
              {(id, d) => <Input id={id} aria-describedby={d} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required />}
            </Field>
            <Field label="Confirm new password">{(id) => <Input id={id} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />}</Field>
            <Button type="submit" variant="primary" loading={busy}>
              Change password
            </Button>
          </form>
        </Card>
      </div>
    </>
  );
}
