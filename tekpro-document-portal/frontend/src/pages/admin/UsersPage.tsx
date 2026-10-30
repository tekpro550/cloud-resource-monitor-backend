import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { Alert, Badge, Button, Card, ConfirmDialog, EmptyState, ErrorState, Field, Input, Modal, PageHeader, Pagination, Select, Spinner } from "../../components/ui";
import { useAsync, useDebounced } from "../../hooks/useAsync";
import { useCurrentUser } from "../../hooks/useAuth";
import { errorMessage } from "../../services/api";
import { auditApi, customersApi, foldersApi, usersApi, type InviteResult } from "../../services/endpoints";
import type { Customer, FolderPermission, Role, User } from "../../types/api";
import { describeAction, formatDateTime, ROLE_LABELS } from "../../utils/format";
import { pathTo } from "../../features/explorer/FolderTree";

const CUSTOMER_ROLES: Role[] = ["CUSTOMER_ADMIN", "CUSTOMER_USER"];

function InviteNotice({ invite }: { invite: InviteResult }) {
  return (
    <Alert kind={invite.emailSent ? "success" : "warning"}>
      {invite.emailSent ? "A password link was emailed to the user." : "Email delivery is not configured, so no message was sent."}
      {invite.link && (
        <>
          <br />
          Share this single-use link with the user through a secure channel:
          <code className="copy-link">{invite.link}</code>
        </>
      )}
    </Alert>
  );
}

export function UserFormDialog({ fixedCustomer, onClose, onCreated }: { fixedCustomer?: Customer; onClose: () => void; onCreated: (u: User) => void }) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<Role>(fixedCustomer ? "CUSTOMER_USER" : "TEKPRO_USER");
  const [customerId, setCustomerId] = useState(fixedCustomer?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [invite, setInvite] = useState<InviteResult | null>(null);
  const customers = useAsync(() => (fixedCustomer ? Promise.resolve(null) : customersApi.list({ pageSize: 100, status: "ACTIVE" })), [fixedCustomer]);
  const needsCustomer = CUSTOMER_ROLES.includes(role);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await usersApi.create({ email, fullName, role, customerId: needsCustomer ? customerId : null });
      setInvite(res.invite);
      onCreated(res.user);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="New user"
      onClose={onClose}
      footer={
        invite ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={() => submit()} disabled={!email || !fullName || (needsCustomer && !customerId)}>
              Create user
            </Button>
          </>
        )
      }
    >
      {invite ? (
        <InviteNotice invite={invite} />
      ) : (
        <form className="form" onSubmit={submit}>
          <Field label="Full name">{(id) => <Input id={id} value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={200} autoFocus />}</Field>
          <Field label="Email address">{(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} />}</Field>
          <Field label="Role">
            {(id) => (
              <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
                {(fixedCustomer ? CUSTOMER_ROLES : (Object.keys(ROLE_LABELS) as Role[])).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {needsCustomer && !fixedCustomer && (
            <Field label="Customer">
              {(id) => (
                <Select id={id} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
                  <option value="">Select a customer…</option>
                  {customers.data?.items.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
          <p className="muted small">The user receives a single-use link to set their own password. No password is set by the administrator.</p>
          {error ? <Alert kind="error">{errorMessage(error)}</Alert> : null}
          <button type="submit" hidden />
        </form>
      )}
    </Modal>
  );
}

export function UsersPage() {
  const [q, setQ] = useState("");
  const query = useDebounced(q.trim());
  const [scope, setScope] = useState("");
  const [status, setStatus] = useState("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const list = useAsync(() => usersApi.list({ q: query, scope, status, page, pageSize: 20 }), [query, scope, status, page]);

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Super Admins, Agents, Customers and Users"
        actions={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New user
          </Button>
        }
      />
      <Card>
        <div className="filters" role="search">
          <Input type="search" aria-label="Search users" placeholder="Search by name or email…" value={q} onChange={(e) => (setQ(e.target.value), setPage(1))} />
          <Select aria-label="User type" value={scope} onChange={(e) => (setScope(e.target.value), setPage(1))}>
            <option value="">All users</option>
            <option value="staff">Super Admins and Agents</option>
            <option value="customer">Customers and Users</option>
          </Select>
          <Select aria-label="Status" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
            <option value="">Any status</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
        </div>
        {list.loading && !list.data ? (
          <Spinner />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={list.reload} />
        ) : !list.data?.items.length ? (
          <EmptyState title="No users found." />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Role</th>
                    <th scope="col">Customer</th>
                    <th scope="col">Status</th>
                    <th scope="col">Last sign-in</th>
                    <th scope="col" className="th-actions">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {list.data.items.map((u) => (
                    <tr key={u.id}>
                      <td data-label="Name">
                        <strong>{u.fullName}</strong>
                        <span className="doc-desc">{u.email}</span>
                      </td>
                      <td data-label="Role">{ROLE_LABELS[u.role]}</td>
                      <td data-label="Customer">{u.customer?.name ?? "—"}</td>
                      <td data-label="Status">
                        <Badge tone={u.status === "ACTIVE" ? "success" : "neutral"}>{u.status.toLowerCase()}</Badge> {u.locked && <Badge tone="danger">locked</Badge>}
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
            <Pagination {...list.data.pagination} onPage={setPage} />
          </>
        )}
      </Card>
      {creating && <UserFormDialog onClose={() => setCreating(false)} onCreated={() => list.reload()} />}
    </>
  );
}

export function UserDetailPage() {
  const { userId } = useParams();
  const id = userId!;
  const me = useCurrentUser();
  const detail = useAsync(() => usersApi.get(id), [id]);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"deactivate" | "activate" | "reset" | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [invite, setInvite] = useState<InviteResult | null>(null);

  if (detail.loading && !detail.data) return <Spinner />;
  if (detail.error) return <ErrorState error={detail.error} onRetry={detail.reload} />;
  const { user, assignments, folderPermissions } = detail.data!;
  const isSelf = user.id === me.id;

  const runAction = async () => {
    setBusy(true);
    setActionError(null);
    try {
      if (confirm === "deactivate") await usersApi.deactivate(id);
      if (confirm === "activate") await usersApi.activate(id);
      if (confirm === "reset") setInvite(await usersApi.passwordReset(id));
      setConfirm(null);
      detail.reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title={user.fullName}
        subtitle={
          <>
            {user.email} · {ROLE_LABELS[user.role]}
            {user.customer ? ` · ${user.customer.name}` : ""} · <Badge tone={user.status === "ACTIVE" ? "success" : "neutral"}>{user.status.toLowerCase()}</Badge>
          </>
        }
        breadcrumbs={[{ label: "Users", to: "/users" }, { label: user.fullName }]}
        actions={
          <>
            <Button onClick={() => setEditing(true)}>Edit</Button>
            {user.status === "ACTIVE" && <Button onClick={() => setConfirm("reset")}>{user.passwordSet ? "Send password reset" : "Resend invitation"}</Button>}
            {!isSelf &&
              (user.status === "ACTIVE" ? (
                <Button variant="danger" onClick={() => setConfirm("deactivate")}>
                  Deactivate
                </Button>
              ) : (
                <Button onClick={() => setConfirm("activate")}>Activate</Button>
              ))}
          </>
        }
      />
      {invite && <InviteNotice invite={invite} />}
      <div className="grid-2">
        <Card title="Account">
          <dl className="details">
            <dt>Created</dt>
            <dd>{formatDateTime(user.createdAt)}</dd>
            <dt>Last sign-in</dt>
            <dd>{formatDateTime(user.lastLoginAt)}</dd>
            <dt>Password</dt>
            <dd>{user.passwordSet ? "Set" : "Not set (invitation pending)"}</dd>
            <dt>Locked</dt>
            <dd>{user.locked ? "Yes (too many failed sign-ins)" : "No"}</dd>
          </dl>
        </Card>
        {user.role === "TEKPRO_USER" && (
          <Card title="Assigned customers">
            {assignments.length ? (
              <ul className="simple-list">
                {assignments.map((a) => (
                  <li key={a.id}>
                    <Link to={`/customers/${a.customer.id}`}>{a.customer.name}</Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="No customers assigned." />
            )}
            <p className="muted small">Manage assignments from each customer's “Agents” tab.</p>
          </Card>
        )}
        {user.role === "CUSTOMER_USER" && user.customerId && (
          <FolderPermissionsCard userId={user.id} customerId={user.customerId} current={folderPermissions} onChanged={detail.reload} />
        )}
        {user.role === "CUSTOMER_ADMIN" && (
          <Card title="Folder access">
            <p>Customer accounts can browse and download every folder of their organisation that is not hidden from the customer.</p>
          </Card>
        )}
      </div>
      <UserActivity userId={user.id} />
      {editing && <EditUserDialog user={user} isSelf={isSelf} onClose={() => setEditing(false)} onSaved={() => (setEditing(false), detail.reload())} />}
      {confirm && (
        <ConfirmDialog
          title={confirm === "deactivate" ? "Deactivate user" : confirm === "activate" ? "Activate user" : "Send password link"}
          danger={confirm === "deactivate"}
          busy={busy}
          error={actionError}
          confirmLabel={confirm === "deactivate" ? "Deactivate" : confirm === "activate" ? "Activate" : "Send"}
          message={
            confirm === "deactivate"
              ? "The user will be signed out everywhere immediately and will not be able to sign in."
              : confirm === "activate"
                ? "The user will be able to sign in again."
                : "A single-use password link will be sent to the user's email address. Any earlier link stops working."
          }
          onCancel={() => setConfirm(null)}
          onConfirm={runAction}
        />
      )}
    </>
  );
}

function EditUserDialog({ user, isSelf, onClose, onSaved }: { user: User; isSelf: boolean; onClose: () => void; onSaved: () => void }) {
  const [fullName, setFullName] = useState(user.fullName);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<Role>(user.role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const roleOptions: Role[] = CUSTOMER_ROLES.includes(user.role) ? CUSTOMER_ROLES : ["SUPER_ADMIN", "TEKPRO_USER"];
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await usersApi.update(user.id, {
        fullName: fullName !== user.fullName ? fullName : undefined,
        email: email !== user.email ? email : undefined,
        role: role !== user.role ? role : undefined,
      });
      onSaved();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Edit user"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="form">
        <Field label="Full name">{(id) => <Input id={id} value={fullName} onChange={(e) => setFullName(e.target.value)} />}</Field>
        <Field label="Email address" hint="Changing the email signs the user out of all sessions.">
          {(id, d) => <Input id={id} aria-describedby={d} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />}
        </Field>
        <Field label="Role" hint={isSelf ? "You cannot change your own role." : "Changing the role signs the user out of all sessions."}>
          {(id, d) => (
            <Select id={id} aria-describedby={d} value={role} disabled={isSelf} onChange={(e) => setRole(e.target.value as Role)}>
              {roleOptions.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {error ? <Alert kind="error">{errorMessage(error)}</Alert> : null}
      </div>
    </Modal>
  );
}

function FolderPermissionsCard({
  userId,
  customerId,
  current,
  onChanged,
}: {
  userId: string;
  customerId: string;
  current: { folderId: string; folderName: string; permission: FolderPermission }[];
  onChanged: () => void;
}) {
  const folders = useAsync(() => foldersApi.list(customerId), [customerId]);
  const [folderId, setFolderId] = useState("");
  const [permission, setPermission] = useState<FolderPermission>("DOWNLOAD");
  const [error, setError] = useState<unknown>(null);
  const label = (id: string) => pathTo(folders.data ?? [], id).map((f) => f.name).join(" / ");

  const apply = async (fid: string, perm: FolderPermission | null) => {
    setError(null);
    try {
      if (perm) await usersApi.setFolderPermission(userId, fid, perm);
      else await usersApi.removeFolderPermission(userId, fid);
      onChanged();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <Card title="Folder permissions">
      <p className="muted small">
        A grant applies to the folder and its subfolders. A nearer grant overrides a broader one, and “No access” blocks the whole subfolder tree. Users are always
        download-only.
      </p>
      {current.length ? (
        <ul className="simple-list">
          {current.map((p) => (
            <li key={p.folderId} className="simple-list-row">
              <span>{folders.data ? label(p.folderId) || p.folderName : p.folderName}</span>
              <span className="row-actions">
                <Select aria-label={`Permission for ${p.folderName}`} value={p.permission} onChange={(e) => apply(p.folderId, e.target.value as FolderPermission)}>
                  <option value="DOWNLOAD">Download</option>
                  <option value="VIEW">View only</option>
                  <option value="NONE">No access</option>
                </Select>
                <Button size="sm" variant="ghost" className="text-danger" onClick={() => apply(p.folderId, null)}>
                  Remove
                </Button>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No folders assigned. This user cannot see any documents yet." />
      )}
      <div className="inline-form">
        <Select aria-label="Folder" value={folderId} onChange={(e) => setFolderId(e.target.value)}>
          <option value="">Select a folder…</option>
          {(folders.data ?? [])
            .filter((f) => !current.some((c) => c.folderId === f.id))
            .map((f) => ({ id: f.id, l: label(f.id) }))
            .sort((a, b) => a.l.localeCompare(b.l))
            .map((f) => (
              <option key={f.id} value={f.id}>
                {f.l}
              </option>
            ))}
        </Select>
        <Select aria-label="Permission" value={permission} onChange={(e) => setPermission(e.target.value as FolderPermission)}>
          <option value="DOWNLOAD">Download</option>
          <option value="VIEW">View only</option>
          <option value="NONE">No access</option>
        </Select>
        <Button
          variant="primary"
          disabled={!folderId}
          onClick={async () => {
            await apply(folderId, permission);
            setFolderId("");
          }}
        >
          Grant
        </Button>
      </div>
      {error ? <Alert kind="error">{errorMessage(error)}</Alert> : null}
    </Card>
  );
}

function UserActivity({ userId }: { userId: string }) {
  const [page, setPage] = useState(1);
  const logs = useAsync(() => auditApi.list({ actorUserId: userId, page, pageSize: 10 }), [userId, page]);
  return (
    <Card title="Recent activity">
      {logs.loading && !logs.data ? (
        <Spinner />
      ) : logs.error ? (
        <ErrorState error={logs.error} onRetry={logs.reload} />
      ) : logs.data?.items.length ? (
        <>
          <ul className="activity-list">
            {logs.data.items.map((a) => (
              <li key={a.id}>
                <span className="activity-main">
                  {describeAction(a.action)} {a.outcome !== "SUCCESS" && <Badge tone="danger">{a.outcome.toLowerCase()}</Badge>}
                </span>
                <span className="activity-meta">
                  {a.customer?.name ? `${a.customer.name} · ` : ""}
                  {formatDateTime(a.createdAt)}
                </span>
              </li>
            ))}
          </ul>
          <Pagination {...logs.data.pagination} onPage={setPage} />
        </>
      ) : (
        <EmptyState title="No activity recorded." />
      )}
    </Card>
  );
}
