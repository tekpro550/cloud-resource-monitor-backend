import { Link } from "react-router-dom";
import { Card, EmptyState, ErrorState, PageHeader, Spinner, StatTile } from "../components/ui";
import { useAsync } from "../hooks/useAsync";
import { useAuth, useCurrentUser } from "../hooks/useAuth";
import { auditApi, customersApi, documentsApi, foldersApi, statsApi } from "../services/endpoints";
import { describeAction, formatBytes, formatDate, formatDateTime } from "../utils/format";

export function DashboardPage() {
  const user = useCurrentUser();
  if (user.role === "SUPER_ADMIN") return <SuperAdminDashboard />;
  if (user.role === "TEKPRO_USER") return <StaffDashboard />;
  return <CustomerDashboard />;
}

function SuperAdminDashboard() {
  const stats = useAsync(() => statsApi.overview(), []);
  return (
    <>
      <PageHeader title="Platform overview" subtitle="Super Admin" />
      {stats.loading ? (
        <Spinner />
      ) : stats.error ? (
        <ErrorState error={stats.error} onRetry={stats.reload} />
      ) : stats.data ? (
        <>
          <div className="stats-grid">
            <StatTile label="Active customers" value={stats.data.activeCustomers} />
            <StatTile label="Active users" value={stats.data.activeUsers} />
            <StatTile label="Documents" value={stats.data.documents.toLocaleString()} />
            <StatTile label="Storage used" value={formatBytes(stats.data.storedBytes)} />
            <StatTile label="Uploaded (24h)" value={formatBytes(stats.data.last24h.bytes)} hint={`${stats.data.last24h.uploads} files`} />
          </div>
          <div className="grid-3">
            <Card title="Recent uploads">
              {stats.data.recentUploads.length ? (
                <ul className="activity-list">
                  {stats.data.recentUploads.map((u) => (
                    <li key={u.id}>
                      <span className="activity-main">{u.displayName}</span>
                      <span className="activity-meta">
                        {u.customer.name} · {formatBytes(u.sizeBytes)} · {formatDateTime(u.availableAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No uploads yet" />
              )}
            </Card>
            <Card title="Recent download requests">
              {stats.data.recentDownloads.length ? (
                <ul className="activity-list">
                  {stats.data.recentDownloads.map((d) => (
                    <li key={d.id}>
                      <span className="activity-main">{d.documentName ?? "Document"}</span>
                      <span className="activity-meta">
                        {d.actor?.fullName ?? "Unknown"} · {d.customer?.name} · {formatDateTime(d.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No downloads yet" />
              )}
            </Card>
            <Card title="Administrative events" actions={<Link to="/audit">View all</Link>}>
              {stats.data.recentAdminEvents.length ? (
                <ul className="activity-list">
                  {stats.data.recentAdminEvents.map((e) => (
                    <li key={e.id}>
                      <span className="activity-main">{describeAction(e.action)}</span>
                      <span className="activity-meta">
                        {e.actor?.fullName ?? "System"} {e.customer ? `· ${e.customer.name}` : ""} · {formatDateTime(e.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState title="No events yet" />
              )}
            </Card>
          </div>
          <div className="quick-links">
            <Link className="btn btn-secondary btn-md" to="/customers">
              Manage customers
            </Link>
            <Link className="btn btn-secondary btn-md" to="/users">
              Manage users
            </Link>
            <Link className="btn btn-secondary btn-md" to="/storage">
              Storage statistics
            </Link>
          </div>
        </>
      ) : null}
    </>
  );
}

function StaffDashboard() {
  const user = useCurrentUser();
  const { features } = useAuth();
  const customers = useAsync(() => customersApi.list({ pageSize: 100 }), []);
  const activity = useAsync(() => (features.activityAccess ? auditApi.list({ pageSize: 8 }) : Promise.resolve(null)), [features.activityAccess]);
  return (
    <>
      <PageHeader title={`Welcome, ${user.fullName}`} subtitle="Your assigned customers" />
      {customers.loading ? (
        <Spinner />
      ) : customers.error ? (
        <ErrorState error={customers.error} onRetry={customers.reload} />
      ) : customers.data?.items.length ? (
        <div className="customer-cards">
          {customers.data.items.map((c) => (
            <Link key={c.id} to={`/customers/${c.id}/documents`} className="customer-card">
              <span className="customer-card-name">{c.name}</span>
              <span className="customer-card-code">{c.customerCode}</span>
              <span className="customer-card-meta">
                {c.documentCount ?? 0} documents · {formatBytes(c.totalBytes ?? 0)}
              </span>
              <span className="customer-card-cta">Open documents →</span>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState title="No customers assigned">
          <p>A Super Admin needs to assign customers to your account before you can manage documents.</p>
        </EmptyState>
      )}
      {activity.data && (
        <Card title="Recent activity in your customers" actions={<Link to="/audit">View all</Link>}>
          {activity.data.items.length ? (
            <ul className="activity-list">
              {activity.data.items.map((a) => (
                <li key={a.id}>
                  <span className="activity-main">{describeAction(a.action)}</span>
                  <span className="activity-meta">
                    {a.actor?.fullName ?? "System"} · {a.customer?.name} · {formatDateTime(a.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No activity yet" />
          )}
        </Card>
      )}
    </>
  );
}

function CustomerDashboard() {
  const user = useCurrentUser();
  const customerId = user.customerId!;
  const folders = useAsync(() => foldersApi.list(customerId), [customerId]);
  const recent = useAsync(() => documentsApi.list(customerId, { sort: "date", order: "desc", pageSize: 8 }), [customerId]);
  const roots = (folders.data ?? []).filter((f) => !f.parentFolderId);
  return (
    <>
      <PageHeader title={user.customer?.name ?? "Documents"} subtitle={`Welcome, ${user.fullName}`} />
      <div className="grid-2">
        <Card title="Your folders" actions={<Link to="/documents">Browse all</Link>}>
          {folders.loading ? (
            <Spinner />
          ) : folders.error ? (
            <ErrorState error={folders.error} onRetry={folders.reload} />
          ) : roots.length ? (
            <ul className="folder-links">
              {roots.map((f) => (
                <li key={f.id}>
                  <Link to={`/documents?folder=${f.id}`}>
                    <span aria-hidden="true">📁</span> {f.name}
                  </Link>
                  <span className="muted small">{f.access === "VIEW" ? "View only" : ""}</span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No folders have been shared with you yet." />
          )}
        </Card>
        <Card title="Recently added documents">
          {recent.loading ? (
            <Spinner />
          ) : recent.error ? (
            <ErrorState error={recent.error} onRetry={recent.reload} />
          ) : recent.data?.items.length ? (
            <ul className="activity-list">
              {recent.data.items.map((d) => (
                <li key={d.id}>
                  <Link className="activity-main" to={`/documents?folder=${d.folderId}`}>
                    {d.displayName}
                  </Link>
                  <span className="activity-meta">
                    {d.folderName} · {formatBytes(d.sizeBytes)} · {formatDate(d.availableAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState title="No documents available yet." />
          )}
        </Card>
      </div>
    </>
  );
}
