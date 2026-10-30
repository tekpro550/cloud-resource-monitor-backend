import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Alert, Badge, Button, Card, ErrorState, Field, Input, PageHeader, Spinner, StatTile } from "../../components/ui";
import { useAsync } from "../../hooks/useAsync";
import { useAuth, useCurrentUser } from "../../hooks/useAuth";
import { errorMessage } from "../../services/api";
import { authApi, settingsApi, statsApi } from "../../services/endpoints";
import type { OperationalSettings, PortalSettings, SettingsPayload } from "../../types/api";
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
  // Same rule as the server's storage limit: uploads in progress, documents, and deleted documents not yet purged.
  const used = (c: (typeof customers)[number]) =>
    ["PENDING_UPLOAD", "AVAILABLE", "DELETED"].reduce((n, st) => n + (c.byStatus[st]?.bytes ?? 0), 0);
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
                <th scope="col">Used / limit</th>
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
                    <td data-label="Used / limit">
                      {formatBytes(used(c))} / {c.storageQuotaBytes ? formatBytes(c.storageQuotaBytes) : "no limit"}
                      {c.storageQuotaBytes ? (
                        <span className="doc-desc">{formatBytes(Math.max(0, c.storageQuotaBytes - used(c)))} available</span>
                      ) : null}
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

const PERMISSION_GROUPS: { title: string; items: { key: keyof PortalSettings; label: string; hint: string }[] }[] = [
  {
    title: "Tekpro team",
    items: [
      { key: "staffAuditAccess", label: "Can see activity logs of their customers", hint: "Only for the customers assigned to each staff member." },
      { key: "staffCanDeleteDocuments", label: "Can delete documents", hint: "When off, only Super Admins can delete documents." },
      { key: "staffCanDeleteFolders", label: "Can delete folders", hint: "When off, only Super Admins can delete folders." },
    ],
  },
  {
    title: "Customer organisations",
    items: [
      { key: "customerAdminActivityAccess", label: "Customer admins can see their organisation's activity", hint: "Downloads and sign-ins by people in their own organisation." },
      {
        key: "customerAdminCanManageStorage",
        label: "Customer admins can create and delete their storage bucket",
        hint: "Only for organisations whose documents are kept in their own AWS account.",
      },
      { key: "customerUserActivityAccess", label: "Customer team members can see their own activity", hint: "Their own downloads and sign-ins." },
    ],
  },
];

type Unit = { label: string; factor: number };
const MB: Unit = { label: "MB", factor: 1024 ** 2 };
const GB: Unit = { label: "GB", factor: 1024 ** 3 };
const MIN: Unit = { label: "minutes", factor: 60 };
const HOURS: Unit = { label: "hours", factor: 3600 };
const DAYS: Unit = { label: "days", factor: 1 };

type NumericKey = Exclude<keyof OperationalSettings, "uploadAllowedExtensions">;
const LIMIT_GROUPS: { title: string; items: { key: NumericKey; label: string; hint: string; unit: Unit }[] }[] = [
  {
    title: "Uploads",
    items: [
      { key: "uploadMaxFileSizeBytes", label: "Largest file allowed", hint: "Per file. Up to 5,120 GB.", unit: GB },
      { key: "uploadMultipartThresholdBytes", label: "Upload large files in parts above", hint: "Bigger files upload in parallel parts that can be retried.", unit: MB },
      { key: "uploadPartSizeBytes", label: "Size of each upload part", hint: "5 MB to 5,120 MB. At most 10,000 parts per file.", unit: MB },
      { key: "uploadUrlTtlSeconds", label: "Upload link valid for", hint: "1 to 15 minutes.", unit: MIN },
      { key: "uploadSessionTtlSeconds", label: "Unfinished uploads are cancelled after", hint: "Abandoned uploads are cleaned up after this time.", unit: HOURS },
    ],
  },
  {
    title: "Downloads and deleted documents",
    items: [
      { key: "downloadUrlTtlSeconds", label: "Download link valid for", hint: "0.5 to 15 minutes. Shorter is safer.", unit: MIN },
      { key: "deletedDocumentRetentionDays", label: "Keep deleted documents for", hint: "They can be restored during this time, then are removed for good. 0 = remove at once.", unit: DAYS },
    ],
  },
  {
    title: "Sign-in",
    items: [
      { key: "sessionIdleTimeoutSeconds", label: "Sign out after inactivity of", hint: "1 minute to 24 hours.", unit: MIN },
      { key: "sessionTtlSeconds", label: "Sign in again at the latest after", hint: "Applies to new sign-ins. Up to 30 days.", unit: HOURS },
    ],
  },
];

const fmtUnit = (value: number, unit: Unit) => String(Math.round((value / unit.factor) * 100) / 100);

function PermissionsCard({ settings, onSaved }: { settings: PortalSettings; onSaved: (s: SettingsPayload) => void }) {
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const toggle = async (key: keyof PortalSettings, value: boolean) => {
    setSaving(key);
    setError(null);
    try {
      onSaved(await settingsApi.update({ [key]: value }));
    } catch (err) {
      setError(err);
    } finally {
      setSaving(null);
    }
  };
  return (
    <Card title="Who can do what">
      {error ? <Alert kind="error">{errorMessage(error)}</Alert> : null}
      {PERMISSION_GROUPS.map((group) => (
        <div key={group.title} className="settings-group">
          <h3 className="section-title">{group.title}</h3>
          <ul className="settings-list">
            {group.items.map(({ key, label, hint }) => (
              <li key={key}>
                <label className="switch-row">
                  <input type="checkbox" checked={settings[key]} disabled={saving === key} onChange={(e) => toggle(key, e.target.checked)} />
                  <span>
                    <span className="switch-label">{label}</span>
                    <span className="muted small">{hint}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </Card>
  );
}

function LimitsCard({ operational, onSaved }: { operational: SettingsPayload["operational"]; onSaved: (s: SettingsPayload) => void }) {
  const { values, defaults, overridden } = operational;
  const initial = () => {
    const out: Record<string, string> = { uploadAllowedExtensions: values.uploadAllowedExtensions.join(", ") };
    for (const g of LIMIT_GROUPS) for (const i of g.items) out[i.key] = fmtUnit(values[i.key], i.unit);
    return out;
  };
  const [form, setForm] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);

  const parseExtensions = (text: string) => [...new Set(text.split(/[\s,]+/).map((x) => x.trim().toLowerCase().replace(/^\./, "")).filter(Boolean))].sort();

  const changes = () => {
    const patch: Record<string, number | string[] | null> = {};
    for (const g of LIMIT_GROUPS) {
      for (const i of g.items) {
        const n = Number(form[i.key]);
        if (form[i.key].trim() === "" || !Number.isFinite(n)) throw new Error(`Enter a number for "${i.label}"`);
        const v = Math.round(n * i.unit.factor);
        if (v !== values[i.key]) patch[i.key] = v;
      }
    }
    const ext = parseExtensions(form.uploadAllowedExtensions);
    if (ext.join(",") !== values.uploadAllowedExtensions.join(",")) patch.uploadAllowedExtensions = ext;
    return patch;
  };

  const send = async (patch: Record<string, number | string[] | null>) => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await settingsApi.updateOperational(patch);
      onSaved(res);
      setSaved(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let patch;
    try {
      patch = changes();
    } catch (err) {
      return setError(err);
    }
    if (!Object.keys(patch).length) return setSaved(true);
    await send(patch);
  };

  const reset = async (key: keyof OperationalSettings) => {
    await send({ [key]: null });
    const d = defaults[key];
    setForm((f) => ({
      ...f,
      [key]: Array.isArray(d) ? d.join(", ") : fmtUnit(d, LIMIT_GROUPS.flatMap((g) => g.items).find((i) => i.key === key)!.unit),
    }));
  };

  const defaultNote = (key: keyof OperationalSettings, shown: string) => (
    <span className="field-default">
      {overridden.includes(key) ? (
        <>
          Changed from the default ({shown}).
          <button type="button" className="link-button" onClick={() => void reset(key)} disabled={busy}>
            Reset to default
          </button>
        </>
      ) : (
        <>Default</>
      )}
    </span>
  );

  return (
    <Card title="Limits">
      <p className="muted small">Changes apply straight away to all users and are recorded in the audit log.</p>
      <form className="form" onSubmit={submit}>
        {LIMIT_GROUPS.map((group) => (
          <div key={group.title} className="settings-group">
            <h3 className="section-title">{group.title}</h3>
            <div className="settings-grid">
              {group.items.map((i) => (
                <Field key={i.key} label={i.label} hint={i.hint}>
                  {(id, describedBy) => (
                    <>
                      <span className="unit-input">
                        <Input
                          id={id}
                          aria-describedby={describedBy}
                          type="number"
                          step="any"
                          min="0"
                          value={form[i.key]}
                          onChange={(e) => setForm((f) => ({ ...f, [i.key]: e.target.value }))}
                        />
                        <span>{i.unit.label}</span>
                      </span>
                      {defaultNote(i.key, `${fmtUnit(defaults[i.key], i.unit)} ${i.unit.label}`)}
                    </>
                  )}
                </Field>
              ))}
            </div>
            {group.title === "Uploads" && (
              <Field label="Allowed file types" hint="File extensions separated by commas. Programs and scripts (such as .exe, .js, .html) can never be allowed.">
                {(id, describedBy) => (
                  <>
                    <textarea
                      id={id}
                      aria-describedby={describedBy}
                      className="input"
                      rows={3}
                      value={form.uploadAllowedExtensions}
                      onChange={(e) => setForm((f) => ({ ...f, uploadAllowedExtensions: e.target.value }))}
                    />
                    {defaultNote("uploadAllowedExtensions", "the standard document, image and archive types")}
                  </>
                )}
              </Field>
            )}
          </div>
        ))}
        {error ? <Alert kind="error">{errorMessage(error)}</Alert> : null}
        <div className="form-actions">
          <Button type="submit" variant="primary" loading={busy}>
            Save limits
          </Button>
          {saved && !busy && <span className="muted small">Saved</span>}
        </div>
      </form>
    </Card>
  );
}

const STORAGE_NAMES: Record<string, string> = { s3: "Amazon S3-compatible bucket (Lightsail)", memory: "Test storage (in memory)" };
const MAIL_NAMES: Record<string, string> = {
  smtp: "Sent by email (SMTP)",
  console: "Printed in the server log (development only)",
  disabled: "Off: invitation and reset links are shown to admins instead",
};

export function SettingsPage() {
  const data = useAsync(() => settingsApi.get(), []);
  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  const { settings, operational, environment } = data.data!;

  return (
    <>
      <PageHeader title="Settings" subtitle="Changes take effect immediately and are recorded in the audit log" />
      <PermissionsCard settings={settings} onSaved={(s) => data.setData(s)} />
      <LimitsCard operational={operational} onSaved={(s) => data.setData(s)} />
      <Card title="Server setup">
        <p className="muted small">
          These depend on the server's own configuration and secrets (bucket keys, email password), so they are set where the portal is deployed, not here.
        </p>
        <dl className="details">
          <dt>Document storage</dt>
          <dd>{STORAGE_NAMES[environment.storageDriver] ?? environment.storageDriver}</dd>
          <dt>Emails (invitations, password resets)</dt>
          <dd>{MAIL_NAMES[environment.mailDriver] ?? environment.mailDriver}</dd>
          <dt>Background clean-up</dt>
          <dd>{environment.jobsEnabled ? "Runs inside the portal every 15 minutes" : "Runs as a separate scheduled task"}</dd>
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
