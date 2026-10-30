import { useState, type FormEvent } from "react";
import { Alert, Button, ConfirmDialog, Field, Input, Modal, Select, Spinner } from "../../components/ui";
import { useAsync } from "../../hooks/useAsync";
import { ApiError, errorMessage } from "../../services/api";
import { documentsApi, foldersApi } from "../../services/endpoints";
import type { DocumentItem, Folder } from "../../types/api";
import { pathTo } from "./FolderTree";

function useSubmit(action: () => Promise<unknown>, onDone: () => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
      onDone();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit, setError };
}

const folderLabel = (folders: Folder[], f: Folder) => pathTo(folders, f.id).map((x) => x.name).join(" / ");

function FolderSelect({ folders, value, onChange, exclude, allowRoot, label }: { folders: Folder[]; value: string; onChange: (v: string) => void; exclude?: (f: Folder) => boolean; allowRoot?: boolean; label: string }) {
  const options = folders.filter((f) => !exclude?.(f)).map((f) => ({ id: f.id, label: folderLabel(folders, f) })).sort((a, b) => a.label.localeCompare(b.label));
  return (
    <Field label={label}>
      {(id) => (
        <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {allowRoot && <option value="">(Top level)</option>}
          {!allowRoot && <option value="">Select a folder…</option>}
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
    </Field>
  );
}

function FormModal({ title, busy, error, submitLabel, onClose, onSubmit, children, disabled }: { title: string; busy: boolean; error: unknown; submitLabel: string; onClose: () => void; onSubmit: (e?: FormEvent) => void; children: React.ReactNode; disabled?: boolean }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={disabled} onClick={() => onSubmit()}>
            {submitLabel}
          </Button>
        </>
      }
    >
      <form onSubmit={onSubmit} className="form">
        {children}
        {error ? <Alert kind="error">{errorMessage(error)}</Alert> : null}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

export function NewFolderDialog({ customerId, parent, onClose, onDone }: { customerId: string; parent: Folder | null; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const s = useSubmit(() => foldersApi.create(customerId, name, parent?.id ?? null), onDone);
  return (
    <FormModal title={parent ? `New folder in “${parent.name}”` : "New top-level folder"} busy={s.busy} error={s.error} submitLabel="Create folder" onClose={onClose} onSubmit={s.submit} disabled={!name.trim()}>
      <Field label="Folder name">{(id) => <Input id={id} value={name} maxLength={255} onChange={(e) => setName(e.target.value)} autoFocus />}</Field>
    </FormModal>
  );
}

export function RenameDialog({ kind, current, onClose, onSave }: { kind: "folder" | "document"; current: string; onClose: () => void; onSave: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState(current);
  const s = useSubmit(() => onSave(name), onClose);
  return (
    <FormModal title={`Rename ${kind}`} busy={s.busy} error={s.error} submitLabel="Save" onClose={onClose} onSubmit={s.submit} disabled={!name.trim() || name === current}>
      <Field label={kind === "folder" ? "Folder name" : "File name"} hint={kind === "document" ? "The file extension cannot be changed." : undefined}>
        {(id, d) => <Input id={id} aria-describedby={d} value={name} maxLength={255} onChange={(e) => setName(e.target.value)} autoFocus />}
      </Field>
    </FormModal>
  );
}

export function MoveFolderDialog({ folder, folders, onClose, onDone }: { folder: Folder; folders: Folder[]; onClose: () => void; onDone: () => void }) {
  const [dest, setDest] = useState(folder.parentFolderId ?? "");
  // A folder cannot move into itself or its own descendants.
  const isDescendant = (f: Folder) => pathTo(folders, f.id).some((x) => x.id === folder.id);
  const s = useSubmit(() => foldersApi.update(folder.id, { parentFolderId: dest || null }), onDone);
  return (
    <FormModal title={`Move “${folder.name}”`} busy={s.busy} error={s.error} submitLabel="Move" onClose={onClose} onSubmit={s.submit} disabled={dest === (folder.parentFolderId ?? "")}>
      <FolderSelect label="Destination" folders={folders} value={dest} onChange={setDest} exclude={isDescendant} allowRoot />
    </FormModal>
  );
}

export function MoveDocumentDialog({ doc, folders, onClose, onDone }: { doc: DocumentItem; folders: Folder[]; onClose: () => void; onDone: () => void }) {
  const [dest, setDest] = useState(doc.folderId);
  const s = useSubmit(() => documentsApi.update(doc.id, { folderId: dest }), onDone);
  return (
    <FormModal title={`Move “${doc.displayName}”`} busy={s.busy} error={s.error} submitLabel="Move" onClose={onClose} onSubmit={s.submit} disabled={!dest || dest === doc.folderId}>
      <FolderSelect label="Destination folder" folders={folders} value={dest} onChange={setDest} />
    </FormModal>
  );
}

export function RestoreDocumentDialog({ doc, folders, onClose, onDone }: { doc: DocumentItem; folders: Folder[]; onClose: () => void; onDone: () => void }) {
  const originalExists = folders.some((f) => f.id === doc.folderId);
  const [dest, setDest] = useState(originalExists ? "" : (folders[0]?.id ?? ""));
  const s = useSubmit(() => documentsApi.restore(doc.id, dest || undefined), onDone);
  return (
    <FormModal title={`Restore “${doc.displayName}”`} busy={s.busy} error={s.error} submitLabel="Restore" onClose={onClose} onSubmit={s.submit} disabled={!originalExists && !dest}>
      {originalExists ? (
        <p>The document will be restored to its original folder unless you choose another.</p>
      ) : (
        <Alert kind="warning">The original folder was deleted. Choose a folder to restore into.</Alert>
      )}
      <FolderSelect label="Restore into" folders={folders} value={dest} onChange={setDest} allowRoot={false} />
    </FormModal>
  );
}

export function DeleteDocumentDialog({ doc, retentionNote, onClose, onDone }: { doc: DocumentItem; retentionNote?: string; onClose: () => void; onDone: () => void }) {
  const s = useSubmit(() => documentsApi.remove(doc.id), onDone);
  return (
    <ConfirmDialog
      title="Delete document"
      danger
      confirmLabel="Delete"
      busy={s.busy}
      error={s.error}
      onCancel={onClose}
      onConfirm={() => s.submit()}
      message={
        <>
          <p>
            Delete <strong>{doc.displayName}</strong>? Customers will no longer see it.
          </p>
          <p className="muted small">{retentionNote ?? "Deleted documents can be restored by Tekpro until the retention period ends."}</p>
        </>
      }
    />
  );
}

/**
 * Folder deletion follows the server policy: empty folders are deleted directly;
 * a non-empty folder requires typing its exact name to confirm.
 */
export function DeleteFolderDialog({ folder, onClose, onDone }: { folder: Folder; onClose: () => void; onDone: () => void }) {
  const [contents, setContents] = useState<{ subfolders: number; documents: number } | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const s = useSubmit(async () => {
    try {
      await foldersApi.remove(folder.id, contents ? { recursive: true, confirmName } : { recursive: false });
    } catch (err) {
      if (err instanceof ApiError && err.code === "FOLDER_NOT_EMPTY" && !contents) {
        setContents(err.details as { subfolders: number; documents: number });
        throw new ApiError(409, "FOLDER_NOT_EMPTY", "This folder is not empty. Review the contents below before confirming.");
      }
      throw err;
    }
  }, onDone);
  return (
    <ConfirmDialog
      title="Delete folder"
      danger
      confirmLabel={contents ? "Delete folder and contents" : "Delete folder"}
      busy={s.busy}
      error={s.error}
      confirmDisabled={!!contents && confirmName !== folder.name}
      onCancel={onClose}
      onConfirm={() => s.submit()}
      message={
        <p>
          Delete the folder <strong>{folder.name}</strong>?
        </p>
      }
    >
      {contents && (
        <div className="form">
          <Alert kind="warning" title="This folder is not empty">
            It contains {contents.subfolders} subfolder(s) and {contents.documents} document(s). They will be deleted and hidden from customers. Documents remain recoverable by Tekpro
            until the retention period ends.
          </Alert>
          <Field label={`Type “${folder.name}” to confirm`}>{(id) => <Input id={id} value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />}</Field>
        </div>
      )}
    </ConfirmDialog>
  );
}

/** Super Admin: customer visibility and per-user grants for a folder. */
export function FolderAccessDialog({ folder, onClose, onChanged }: { folder: Folder; onClose: () => void; onChanged: () => void }) {
  const grants = useAsync(() => foldersApi.permissions(folder.id), [folder.id]);
  const [hidden, setHidden] = useState(!!folder.hiddenFromCustomer);
  const s = useSubmit(async () => {
    await foldersApi.update(folder.id, { hiddenFromCustomer: hidden });
    onChanged();
  }, onClose);
  return (
    <FormModal title={`Customer access: ${folder.name}`} busy={s.busy} error={s.error} submitLabel="Save" onClose={onClose} onSubmit={s.submit} disabled={hidden === !!folder.hiddenFromCustomer}>
      <label className="checkbox">
        <input type="checkbox" checked={hidden} onChange={(e) => setHidden(e.target.checked)} />
        Hide this folder (and its subfolders) from everyone at the customer, including the Customer role
      </label>
      <h3 className="section-title">Customer user grants on this folder</h3>
      {grants.loading ? (
        <Spinner />
      ) : grants.error ? (
        <Alert kind="error">{errorMessage(grants.error)}</Alert>
      ) : grants.data && grants.data.length ? (
        <ul className="simple-list">
          {grants.data.map((g) => (
            <li key={g.user.id}>
              {g.user.fullName} <span className="muted">({g.user.email})</span> — <strong>{g.permission}</strong>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">No explicit grants. Manage grants from each User's page.</p>
      )}
    </FormModal>
  );
}
