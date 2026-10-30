import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { Breadcrumbs, Button, EmptyState, ErrorState, Input, PageHeader, Pagination, Select, Spinner } from "../../components/ui";
import { useAsync, useDebounced } from "../../hooks/useAsync";
import { useCurrentUser } from "../../hooks/useAuth";
import { customersApi, documentsApi, foldersApi } from "../../services/endpoints";
import type { DocumentItem, Folder } from "../../types/api";
import { capabilities } from "../../utils/permissions";
import { DocumentTable, type SortKey } from "./DocumentTable";
import { FolderTree, pathTo } from "./FolderTree";
import { UploadPanel } from "./UploadPanel";
import {
  DeleteDocumentDialog,
  DeleteFolderDialog,
  FolderAccessDialog,
  MoveDocumentDialog,
  MoveFolderDialog,
  NewFolderDialog,
  RenameDialog,
  RestoreDocumentDialog,
} from "./dialogs";

const TYPE_FILTERS = [
  ["", "All types"],
  ["pdf", "PDF"],
  ["document", "Documents"],
  ["spreadsheet", "Spreadsheets"],
  ["presentation", "Presentations"],
  ["image", "Images"],
  ["archive", "Archives"],
  ["drawing", "Drawings"],
  ["email", "Email"],
] as const;

type Dialog =
  | { kind: "newFolder" }
  | { kind: "renameFolder"; folder: Folder }
  | { kind: "moveFolder"; folder: Folder }
  | { kind: "deleteFolder"; folder: Folder }
  | { kind: "folderAccess"; folder: Folder }
  | { kind: "renameDoc"; doc: DocumentItem }
  | { kind: "moveDoc"; doc: DocumentItem }
  | { kind: "deleteDoc"; doc: DocumentItem }
  | { kind: "restoreDoc"; doc: DocumentItem }
  | null;

/** Customer-role route: the explorer for the user's own customer. */
export function MyDocumentsPage() {
  const user = useCurrentUser();
  if (!user.customerId) return <EmptyState title="No customer account is associated with your user." />;
  return <Explorer customerId={user.customerId} />;
}

export function CustomerExplorerPage() {
  const { customerId } = useParams();
  return <Explorer customerId={customerId!} key={customerId} />;
}

export function Explorer({ customerId }: { customerId: string }) {
  const user = useCurrentUser();
  const caps = capabilities(user.role);
  const [params, setParams] = useSearchParams();
  const folderId = params.get("folder");
  const [q, setQ] = useState(params.get("q") ?? "");
  const query = useDebounced(q.trim(), 300);
  const [type, setType] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [status, setStatus] = useState("AVAILABLE");
  const [sort, setSort] = useState<SortKey>("date");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog>(null);

  const customer = useAsync(() => customersApi.get(customerId), [customerId]);
  const folders = useAsync(() => foldersApi.list(customerId), [customerId]);
  const searching = !!query || !!type || !!from || !!to;
  const docs = useAsync(
    () =>
      documentsApi.list(customerId, {
        folderId: folderId ?? undefined,
        recursive: searching && folderId ? true : undefined,
        q: query || undefined,
        type: type || undefined,
        from: from ? new Date(`${from}T00:00:00`).toISOString() : undefined,
        to: to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined,
        status: caps.viewDocumentLifecycle ? status : undefined,
        sort,
        order,
        page,
        pageSize: 25,
      }),
    [customerId, folderId, query, type, from, to, status, sort, order, page],
  );

  const folderList = useMemo(() => folders.data ?? [], [folders.data]);
  const current = useMemo(() => folderList.find((f) => f.id === folderId) ?? null, [folderList, folderId]);
  const trail = useMemo(() => pathTo(folderList, folderId), [folderList, folderId]);
  const children = useMemo(() => folderList.filter((f) => f.parentFolderId === (folderId ?? null)), [folderList, folderId]);

  const selectFolder = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set("folder", id);
    else next.delete("folder");
    setParams(next);
    setPage(1);
  };

  const onSort = (key: SortKey) => {
    if (key === sort) setOrder(order === "asc" ? "desc" : "asc");
    else {
      setSort(key);
      setOrder(key === "name" ? "asc" : "desc");
    }
    setPage(1);
  };

  const refreshAll = () => {
    folders.reload();
    docs.reload();
  };
  const closeAnd = (fn?: () => void) => () => {
    setDialog(null);
    fn?.();
  };

  if (customer.error) return <ErrorState error={customer.error} />;

  return (
    <div className="explorer">
      <PageHeader
        title={customer.data?.name ?? "Documents"}
        subtitle={caps.manageContent ? "Organise folders and upload documents for this customer." : "Browse and download documents shared with your organisation."}
        breadcrumbs={caps.browseAllCustomers ? [{ label: "Customers", to: "/customers" }, { label: customer.data?.name ?? "…" }] : undefined}
      />

      <div className="explorer-grid">
        <aside className="explorer-sidebar card">
          <div className="explorer-sidebar-head">
            <h2 className="card-title">Folders</h2>
            {caps.manageContent && (
              <Button size="sm" onClick={() => setDialog({ kind: "newFolder" })}>
                + Folder
              </Button>
            )}
          </div>
          {folders.loading && !folders.data ? (
            <Spinner label="Loading folders" />
          ) : folders.error ? (
            <ErrorState error={folders.error} onRetry={folders.reload} />
          ) : (
            <FolderTree folders={folderList} selectedId={folderId} onSelect={selectFolder} showHidden={caps.manageFolderAccess || caps.manageContent} />
          )}
        </aside>

        <section className="explorer-main">
          <div className="card">
            <div className="explorer-toolbar">
              <Breadcrumbs
                items={[
                  { label: "All documents", onClick: () => selectFolder(null) },
                  ...trail.map((f) => ({ label: f.name, onClick: () => selectFolder(f.id) })),
                ]}
              />
              {current && caps.manageContent && (
                <div className="toolbar-actions">
                  <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "newFolder" })}>
                    New subfolder
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "renameFolder", folder: current })}>
                    Rename
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "moveFolder", folder: current })}>
                    Move
                  </Button>
                  {caps.manageFolderAccess && (
                    <Button size="sm" variant="ghost" onClick={() => setDialog({ kind: "folderAccess", folder: current })}>
                      Customer access
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" className="text-danger" onClick={() => setDialog({ kind: "deleteFolder", folder: current })}>
                    Delete
                  </Button>
                </div>
              )}
            </div>

            <div className="filters" role="search">
              <label className="visually-hidden" htmlFor="doc-search">
                Search documents by name
              </label>
              <Input
                id="doc-search"
                type="search"
                placeholder={current ? `Search in ${current.name}…` : "Search all documents…"}
                value={q}
                onChange={(e) => {
                  setQ(e.target.value);
                  setPage(1);
                }}
              />
              <label className="visually-hidden" htmlFor="doc-type">
                File type
              </label>
              <Select
                id="doc-type"
                value={type}
                onChange={(e) => {
                  setType(e.target.value);
                  setPage(1);
                }}
              >
                {TYPE_FILTERS.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </Select>
              <label className="filter-date">
                <span>From</span>
                <Input type="date" value={from} onChange={(e) => (setFrom(e.target.value), setPage(1))} />
              </label>
              <label className="filter-date">
                <span>To</span>
                <Input type="date" value={to} onChange={(e) => (setTo(e.target.value), setPage(1))} />
              </label>
              {caps.viewDocumentLifecycle && (
                <>
                  <label className="visually-hidden" htmlFor="doc-status">
                    Document status
                  </label>
                  <Select id="doc-status" value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))}>
                    <option value="AVAILABLE">Available</option>
                    <option value="PENDING_UPLOAD">Uploading</option>
                    <option value="UPLOAD_FAILED">Failed uploads</option>
                    <option value="DELETED">Recently deleted</option>
                    <option value="MISSING_OBJECT">Missing files</option>
                  </Select>
                </>
              )}
            </div>

            {!searching && children.length > 0 && (
              <ul className="subfolders" aria-label="Subfolders">
                {children.map((f) => (
                  <li key={f.id}>
                    <button type="button" className="subfolder" onClick={() => selectFolder(f.id)}>
                      <span aria-hidden="true">📁</span> {f.name}
                      {typeof f.documentCount === "number" && <span className="muted small"> · {f.documentCount}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {docs.loading && !docs.data ? (
              <Spinner label="Loading documents" />
            ) : docs.error ? (
              <ErrorState error={docs.error} onRetry={docs.reload} />
            ) : docs.data && docs.data.items.length === 0 ? (
              <EmptyState title={searching ? "No documents match your search." : "This folder has no documents yet."}>
                {caps.uploadDocuments && current && !searching && <p>Use the upload area below to add documents.</p>}
              </EmptyState>
            ) : docs.data ? (
              <>
                <DocumentTable
                  documents={docs.data.items}
                  sort={sort}
                  order={order}
                  onSort={onSort}
                  showFolder={!folderId || searching}
                  showStatus={caps.viewDocumentLifecycle && status !== "AVAILABLE"}
                  actions={
                    caps.manageContent
                      ? {
                          onRename: (doc) => setDialog({ kind: "renameDoc", doc }),
                          onMove: (doc) => setDialog({ kind: "moveDoc", doc }),
                          onDelete: (doc) => setDialog({ kind: "deleteDoc", doc }),
                          onRestore: (doc) => setDialog({ kind: "restoreDoc", doc }),
                        }
                      : {}
                  }
                />
                <Pagination page={docs.data.pagination.page} totalPages={docs.data.pagination.totalPages} total={docs.data.pagination.total} onPage={setPage} />
              </>
            ) : null}
          </div>

          {caps.uploadDocuments && <UploadPanel customerId={customerId} folderId={folderId} folderName={current?.name} onUploaded={refreshAll} />}
        </section>
      </div>

      {dialog?.kind === "newFolder" && <NewFolderDialog customerId={customerId} parent={current} onClose={() => setDialog(null)} onDone={closeAnd(folders.reload)} />}
      {dialog?.kind === "renameFolder" && (
        <RenameDialog kind="folder" current={dialog.folder.name} onClose={closeAnd(folders.reload)} onSave={(name) => foldersApi.update(dialog.folder.id, { name })} />
      )}
      {dialog?.kind === "moveFolder" && <MoveFolderDialog folder={dialog.folder} folders={folderList} onClose={() => setDialog(null)} onDone={closeAnd(folders.reload)} />}
      {dialog?.kind === "deleteFolder" && (
        <DeleteFolderDialog
          folder={dialog.folder}
          onClose={() => setDialog(null)}
          onDone={closeAnd(() => {
            selectFolder(dialog.folder.parentFolderId);
            refreshAll();
          })}
        />
      )}
      {dialog?.kind === "folderAccess" && <FolderAccessDialog folder={dialog.folder} onClose={() => setDialog(null)} onChanged={folders.reload} />}
      {dialog?.kind === "renameDoc" && (
        <RenameDialog kind="document" current={dialog.doc.displayName} onClose={closeAnd(docs.reload)} onSave={(displayName) => documentsApi.update(dialog.doc.id, { displayName })} />
      )}
      {dialog?.kind === "moveDoc" && <MoveDocumentDialog doc={dialog.doc} folders={folderList} onClose={() => setDialog(null)} onDone={closeAnd(refreshAll)} />}
      {dialog?.kind === "deleteDoc" && <DeleteDocumentDialog doc={dialog.doc} onClose={() => setDialog(null)} onDone={closeAnd(refreshAll)} />}
      {dialog?.kind === "restoreDoc" && <RestoreDocumentDialog doc={dialog.doc} folders={folderList} onClose={() => setDialog(null)} onDone={closeAnd(refreshAll)} />}
    </div>
  );
}
