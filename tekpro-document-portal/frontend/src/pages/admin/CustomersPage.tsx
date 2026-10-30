import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Pagination, Select, Spinner, StatTile, Tabs } from "../../components/ui";
import { useAsync, useDebounced } from "../../hooks/useAsync";
import { useCurrentUser } from "../../hooks/useAuth";
import { errorMessage } from "../../services/api";
import { customersApi, usersApi } from "../../services/endpoints";
import type { Customer } from "../../types/api";
import { formatBytes, formatDate, formatDateTime, ROLE_LABELS } from "../../utils/format";
import { capabilities } from "../../utils/permissions";
import { CustomerStorageTab } from "../../features/storage/StorageManagement";
import { UserFormDialog } from "./UsersPage";

export function CustomersPage() {
  const user = useCurrentUser();
  const caps = capabilities(user.role);
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim());
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const list = useAsync(() => customersApi.list({ q: query, status, page, pageSize: 20 }), [query, status, page]);
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        title={caps.manageCustomers ? "Customers" : "My customers"}
        subtitle={caps.manageCustomers ? "Customer organisations using the portal" : "Customers assigned to you by a Super Admin"}
        actions={
          caps.manageCustomers && (
            <Button variant="primary" onClick={() => setCreating(true)}>
              New customer
            </Button>
          )
        }
      />
      <Card>
        <div className="filters" role="search">
          <label className="visually-hidden" htmlFor="customer-search">
            Search customers
          </label>
          <Input id="customer-search" type="search" placeholder="Search by name or code…" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
          {caps.manageCustomers && (
            <Select aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </Select>
          )}
        </div>
        {list.loading && !list.data ? (
          <Spinner />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : !list.data?.items.length ? (
          <EmptyState title={query ? "No customers match your search." : caps.manageCustomers ? "No customers yet." : "No customers are assigned to you."} />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Customer</th>
                    <th scope="col">Code</th>
                    <th scope="col">Status</th>
                    <th scope="col">Documents</th>
                    <th scope="col">Storage</th>
                    <th scope="col" className="th-actions">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((c) => (
                    <tr key={c.id}>
                      <td data-label="Customer">
                        <strong>{c.name}</strong>
                      </td>
                      <td data-label="Code">{c.customerCode}</td>
                      <td data-label="Status">
                        <Badge tone={c.status === "ACTIVE" ? "success" : "neutral"}>{c.status.toLowerCase()}</Badge>
                      </td>
                      <td data-label="Documents">{c.documentCount ?? "—"}</td>
                      <td data-label="Storage">{formatBytes(c.totalBytes ?? 0)}</td>
                      <td data-label="Actions" className="td-actions">
                        <div className="row-actions">
                          <Link className="btn btn-primary btn-sm" to={`/customers/${c.id}/documents`}>
                            Documents
                          </Link>
                          {caps.manageCustomers && (
                            <Link className="btn btn-ghost btn-sm" to={`/customers/${c.id}`}>
                              Manage
                            </Link>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination {...list.data.pagination} onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <CustomerFormDialog onClose={() => setCreating(false)} onSaved={(c) => navigate(`/customers/${c.id}`)} />}
    </>
  );
}

function CustomerFormDialog({ customer, onClose, onSaved }: { customer?: Customer; onClose: () => void; onSaved: (c: Customer) => void }) {
  const [name, setName] = useState(customer?.name ?? "");
  const [code, setCode] = useState(customer?.customerCode ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onSaved(customer ? await customersApi.update(customer.id, { name }) : await customersApi.create({ name, customerCode: code }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={customer ? "Edit customer" : "New customer"}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={() => submit()} disabled={!name.trim() || (!customer && !code.trim())}>
            Save
          </Button>
        </>
      }
    >
      <form className="form" onSubmit={submit}>
        <Field label="Organisation name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} autoFocus />}</Field>
        {!customer && (
          <Field label="Customer code" hint="2–32 characters: letters, digits, '-' or '_'. Cannot be changed later.">
            {(id, d) => <Input id={id} aria-describedby={d} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={32} />}
          </Field>
        )}
        {error ? <Alert kind="error">{errorMessage(error)}</Alert> : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

type Tab = "overview" | "staff" | "users" | "storage";

export function CustomerDetailPage() {
  const { customerId } = useParams();
  const id = customerId!;
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (["staff", "users", "storage"].includes(params.get("tab") ?? "") ? (params.get("tab") as Tab) : "overview"));
  const customer = useAsync(() => customersApi.get(id), [id]);
  const [editing, setEditing] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [toggleError, setToggleError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  if (customer.loading && !customer.data) return <Spinner />;
  if (customer.error) return <ErrorState error={customer.error} onRetry={customer.reload} />;
  const c = customer.data!;
  const deactivate = c.status === "ACTIVE";

  return (
    <>
      <PageHeader
        title={c.name}
        subtitle={
          <>
            Code {c.customerCode} · <Badge tone={c.status === "ACTIVE" ? "success" : "neutral"}>{c.status.toLowerCase()}</Badge> · created {formatDate(c.createdAt)}
          </>
        }
        breadcrumbs={[{ label: "Customers", to: "/customers" }, { label: c.name }]}
        actions={
          <>
            <Link className="btn btn-primary btn-md" to={`/customers/${id}/documents`}>
              Open documents
            </Link>
            <Button onClick={() => setEditing(true)}>Edit</Button>
            <Button variant={deactivate ? "danger" : "secondary"} onClick={() => setToggling(true)}>
              {deactivate ? "Deactivate" : "Activate"}
            </Button>
          </>
        }
      />
      <Tabs<Tab>
        tabs={[
          { id: "overview", label: "Overview" },
          { id: "staff", label: "Agents" },
          { id: "users", label: "Customer & Users" },
          { id: "storage", label: "Storage" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "overview" && <CustomerOverview id={id} />}
      {tab === "staff" && <CustomerStaff id={id} />}
      {tab === "users" && <CustomerUsers customer={c} />}
      {tab === "storage" && <CustomerStorageTab customerId={id} />}
      {editing && <CustomerFormDialog customer={c} onClose={() => setEditing(false)} onSaved={(u) => (customer.setData(u), setEditing(false))} />}
      {toggling && (
        <ConfirmDialog
          title={deactivate ? "Deactivate customer" : "Activate customer"}
          danger={deactivate}
          confirmLabel={deactivate ? "Deactivate" : "Activate"}
          busy={busy}
          error={toggleError}
          message={
            deactivate
              ? "All users of this customer will be signed out immediately and will not be able to sign in. Assigned Agents will lose access. Documents are kept."
              : "Users of this customer will be able to sign in again."
          }
          onCancel={() => setToggling(false)}
          onConfirm={async () => {
            setBusy(true);
            try {
              customer.setData(await customersApi.update(id, { status: deactivate ? "INACTIVE" : "ACTIVE" }));
              setToggling(false);
            } catch (err) {
              setToggleError(err);
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </>
  );
}

function CustomerOverview({ id }: { id: string }) {
  const stats = useAsync(() => customersApi.stats(id), [id]);
  if (stats.loading) return <Spinner />;
  if (stats.error) return <ErrorState error={stats.error} onRetry={stats.reload} />;
  const s = stats.data!;
  const avail = s.documentsByStatus.AVAILABLE ?? { count: 0, bytes: 0 };
  return (
    <div className="stats-grid">
      <StatTile label="Available documents" value={avail.count} />
      <StatTile label="Storage used" value={formatBytes(avail.bytes)} />
      <StatTile label="Folders" value={s.folders} />
      <StatTile label="Active Customer & User accounts" value={s.activeUsers} />
      <StatTile label="Uploaded (24h)" value={formatBytes(s.last24h.bytes)} hint={`${s.last24h.uploads} files`} />
      <StatTile label="Deleted (recoverable)" value={s.documentsByStatus.DELETED?.count ?? 0} />
    </div>
  );
}

function CustomerStaff({ id }: { id: string }) {
  const assignments = useAsync(() => customersApi.assignments(id), [id]);
  const staff = useAsync(() => usersApi.list({ role: "TEKPRO_USER", status: "ACTIVE", pageSize: 100 }), []);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const assignedIds = new Set((assignments.data ?? []).map((a) => a.user.id));
  const available = (staff.data?.items ?? []).filter((u) => !assignedIds.has(u.id));

  return (
    <Card title="Agents for this customer">
      <p className="muted">Agents assigned here can upload and manage this customer's folders and documents. They cannot see other customers.</p>
      <div className="inline-form">
        <Select aria-label="Agent to assign" value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">Select a Tekpro user…</option>
          {available.map((u) => (
            <option key={u.id} value={u.id}>
              {u.fullName} ({u.email})
            </option>
          ))}
        </Select>
        <Button
          variant="primary"
          disabled={!selected}
          onClick={async () => {
            setError(null);
            try {
              await customersApi.assign(id, selected);
              setSelected("");
              assignments.reload();
            } catch (err) {
              setError(err);
            }
          }}
        >
          Assign
        </Button>
      </div>
      {error ? <Alert kind="error">{errorMessage(error)}</Alert> : null}
      {assignments.loading ? (
        <Spinner />
      ) : assignments.error ? (
        <ErrorState error={assignments.error} onRetry={assignments.reload} />
      ) : assignments.data?.length ? (
        <ul className="simple-list">
          {assignments.data.map((a) => (
            <li key={a.id} className="simple-list-row">
              <span>
                <strong>{a.user.fullName}</strong> <span className="muted">{a.user.email}</span>
                <span className="muted small"> · assigned {formatDate(a.createdAt)}{a.assignedBy ? ` by ${a.assignedBy.fullName}` : ""}</span>
              </span>
              <Button size="sm" variant="ghost" className="text-danger" onClick={() => setRemoving({ id: a.user.id, name: a.user.fullName })}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No Agents assigned yet." />
      )}
      {removing && (
        <ConfirmDialog
          title="Remove assignment"
          danger
          confirmLabel="Remove"
          message={`${removing.name} will immediately lose access to this customer.`}
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            await customersApi.unassign(id, removing.id).catch(setError);
            setRemoving(null);
            assignments.reload();
          }}
        />
      )}
    </Card>
  );
}

function CustomerUsers({ customer }: { customer: Customer }) {
  const users = useAsync(() => customersApi.users(customer.id), [customer.id]);
  const [creating, setCreating] = useState(false);
  return (
    <Card
      title={`${customer.name}: Customer and User accounts`}
      actions={
        <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
          Add Customer or User
        </Button>
      }
    >
      {users.loading ? (
        <Spinner />
      ) : users.error ? (
        <ErrorState error={users.error} onRetry={users.reload} />
      ) : users.data?.length ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Last sign-in</th>
                <th scope="col" className="th-actions">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.id}>
                  <td data-label="Name">
                    <strong>{u.fullName}</strong>
                    <span className="doc-desc">{u.email}</span>
                  </td>
                  <td data-label="Role">{ROLE_LABELS[u.role]}</td>
                  <td data-label="Status">
                    <Badge tone={u.status === "ACTIVE" ? "success" : "neutral"}>{u.status.toLowerCase()}</Badge>
                    {!u.passwordSet && <Badge tone="info">invited</Badge>}
                  </td>
                  <td data-label="Last sign-in">{formatDateTime(u.lastLoginAt)}</td>
                  <td data-label="Actions" className="td-actions">
                    <Link className="btn btn-ghost btn-sm" to={`/users/${u.id}`}>
                      Manage
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState title="No Customer or User accounts for this customer yet." />
      )}
      {creating && <UserFormDialog fixedCustomer={customer} onClose={() => setCreating(false)} onCreated={() => users.reload()} />}
    </Card>
  );
}
