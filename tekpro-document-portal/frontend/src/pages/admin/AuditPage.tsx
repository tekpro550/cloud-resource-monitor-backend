import { useState } from "react";
import { Badge, Card, EmptyState, ErrorState, Input, PageHeader, Pagination, Select, Spinner } from "../../components/ui";
import { useAsync, useDebounced } from "../../hooks/useAsync";
import { useCurrentUser } from "../../hooks/useAuth";
import { auditApi, customersApi } from "../../services/endpoints";
import { describeAction, formatDateTime } from "../../utils/format";
import { isStaff } from "../../utils/permissions";

const ACTION_GROUPS = [
  ["", "All actions"],
  ["auth.", "Authentication"],
  ["document.download", "Downloads"],
  ["document.upload", "Uploads"],
  ["document.", "All document events"],
  ["folder.", "Folders"],
  ["permission.", "Permissions"],
  ["user.", "Users"],
  ["customer.", "Customers"],
  ["assignment.", "Assignments"],
  ["security.", "Security (denied access)"],
  ["settings.", "Settings"],
] as const;

/** Platform audit log (Super Admin) or assigned-customer audit (Agent). */
export function AuditPage() {
  const user = useCurrentUser();
  const [customerId, setCustomerId] = useState("");
  const [action, setAction] = useState("");
  const [outcome, setOutcome] = useState("");
  const [actorUserId, setActor] = useState("");
  const actor = useDebounced(actorUserId.trim());
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const customers = useAsync(() => customersApi.list({ pageSize: 100 }), []);
  const logs = useAsync(
    () =>
      auditApi.list({
        customerId,
        action,
        outcome,
        actorUserId: /^[0-9a-f-]{36}$/i.test(actor) ? actor : undefined,
        from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
        page,
        pageSize: 25,
      }),
    [customerId, action, outcome, actor, from, to, page],
  );
  const reset = () => setPage(1);

  return (
    <>
      <PageHeader
        title={user.role === "SUPER_ADMIN" ? "Audit logs" : "Activity"}
        subtitle={user.role === "SUPER_ADMIN" ? "Append-only record of security-relevant events across the platform" : "Activity in the customers assigned to you"}
      />
      <Card>
        <div className="filters" role="search">
          <Select aria-label="Customer" value={customerId} onChange={(e) => (setCustomerId(e.target.value), reset())}>
            <option value="">All customers</option>
            {customers.data?.items.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
          <Select aria-label="Action" value={action} onChange={(e) => (setAction(e.target.value), reset())}>
            {ACTION_GROUPS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Select aria-label="Outcome" value={outcome} onChange={(e) => (setOutcome(e.target.value), reset())}>
            <option value="">Any outcome</option>
            <option value="SUCCESS">Success</option>
            <option value="FAILURE">Failure</option>
            <option value="DENIED">Denied</option>
          </Select>
          {user.role === "SUPER_ADMIN" && <Input aria-label="Actor user ID" placeholder="Actor user ID" value={actorUserId} onChange={(e) => (setActor(e.target.value), reset())} />}
          <label className="filter-date">
            <span>From</span>
            <Input type="date" value={from} onChange={(e) => (setFrom(e.target.value), reset())} />
          </label>
          <label className="filter-date">
            <span>To</span>
            <Input type="date" value={to} onChange={(e) => (setTo(e.target.value), reset())} />
          </label>
        </div>
        <AuditTable logs={logs} onPage={setPage} detailed={isStaff(user.role)} />
      </Card>
    </>
  );
}

/** Customer-facing activity view (downloads and sign-ins), when enabled by the Super Admin. */
export function CustomerActivityPage() {
  const user = useCurrentUser();
  const [page, setPage] = useState(1);
  const logs = useAsync(() => auditApi.list({ page, pageSize: 25 }), [page]);
  return (
    <>
      <PageHeader title="Activity" subtitle={user.role === "CUSTOMER_ADMIN" ? "Downloads and sign-ins by users in your organisation" : "Your downloads and sign-ins"} />
      <Card>
        <AuditTable logs={logs} onPage={setPage} detailed={false} />
      </Card>
    </>
  );
}

function AuditTable({ logs, onPage, detailed }: { logs: ReturnType<typeof useAsync<Awaited<ReturnType<typeof auditApi.list>>>>; onPage: (p: number) => void; detailed: boolean }) {
  if (logs.loading && !logs.data) return <Spinner />;
  if (logs.error) return <ErrorState error={logs.error} onRetry={logs.reload} />;
  if (!logs.data?.items.length) return <EmptyState title="No matching activity." />;
  return (
    <>
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th scope="col">Time</th>
              <th scope="col">Event</th>
              <th scope="col">User</th>
              {detailed && <th scope="col">Customer</th>}
              <th scope="col">Outcome</th>
              {detailed && <th scope="col">Details</th>}
            </tr>
          </thead>
          <tbody>
            {logs.data.items.map((a) => (
              <tr key={a.id}>
                <td data-label="Time">{formatDateTime(a.createdAt)}</td>
                <td data-label="Event">
                  {describeAction(a.action)}
                  {!detailed && a.documentName && <span className="doc-desc">{a.documentName}</span>}
                </td>
                <td data-label="User">
                  {a.actor?.fullName ?? "—"}
                  {a.actor?.email && <span className="doc-desc">{a.actor.email}</span>}
                </td>
                {detailed && <td data-label="Customer">{a.customer?.name ?? "—"}</td>}
                <td data-label="Outcome">
                  <Badge tone={a.outcome === "SUCCESS" ? "success" : a.outcome === "DENIED" ? "danger" : "warning"}>{a.outcome.toLowerCase()}</Badge>
                </td>
                {detailed && (
                  <td data-label="Details" className="audit-details">
                    <span className="muted small">
                      {a.resourceType}
                      {a.ipAddress ? ` · ${a.ipAddress}` : ""}
                    </span>
                    {a.metadata && Object.keys(a.metadata).length > 0 && (
                      <details>
                        <summary>Metadata</summary>
                        <pre>{JSON.stringify(a.metadata, null, 2)}</pre>
                      </details>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination {...logs.data.pagination} onPage={onPage} />
    </>
  );
}
