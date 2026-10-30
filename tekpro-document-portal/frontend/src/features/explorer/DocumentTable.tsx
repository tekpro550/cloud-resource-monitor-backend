import { useState } from "react";
import { Badge, Button } from "../../components/ui";
import { errorMessage } from "../../services/api";
import { documentsApi } from "../../services/endpoints";
import type { DocumentItem } from "../../types/api";
import { formatBytes, formatDate, formatDateTime } from "../../utils/format";

export type SortKey = "name" | "size" | "date";
type DownloadState = { status: "preparing" | "started" | "failed"; message?: string };

/**
 * Asks the API for a short-lived download link and hands it to the browser's
 * native download handling (the file is never loaded into page memory).
 */
export async function triggerDownload(doc: DocumentItem): Promise<void> {
  const { url } = await documentsApi.download(doc.id);
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener noreferrer";
  a.download = doc.displayName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  AVAILABLE: "success",
  PENDING_UPLOAD: "info",
  UPLOAD_FAILED: "danger",
  DELETED: "warning",
  MISSING_OBJECT: "danger",
};

export interface DocumentActions {
  onRename?: (d: DocumentItem) => void;
  onMove?: (d: DocumentItem) => void;
  onDelete?: (d: DocumentItem) => void;
  onRestore?: (d: DocumentItem) => void;
}

export function DocumentTable({
  documents,
  sort,
  order,
  onSort,
  showFolder,
  showStatus,
  actions,
}: {
  documents: DocumentItem[];
  sort: SortKey;
  order: "asc" | "desc";
  onSort: (s: SortKey) => void;
  showFolder: boolean;
  showStatus: boolean;
  actions: DocumentActions;
}) {
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});

  const download = async (doc: DocumentItem) => {
    setDownloads((d) => ({ ...d, [doc.id]: { status: "preparing" } }));
    try {
      await triggerDownload(doc);
      setDownloads((d) => ({ ...d, [doc.id]: { status: "started" } }));
    } catch (err) {
      setDownloads((d) => ({ ...d, [doc.id]: { status: "failed", message: errorMessage(err) } }));
    }
  };

  const header = (key: SortKey, label: string) => {
    const active = sort === key;
    return (
      <th scope="col" aria-sort={active ? (order === "asc" ? "ascending" : "descending") : "none"}>
        <button type="button" className="th-sort" onClick={() => onSort(key)}>
          {label}
          <span aria-hidden="true">{active ? (order === "asc" ? " ▲" : " ▼") : ""}</span>
        </button>
      </th>
    );
  };

  const hasManage = !!(actions.onRename || actions.onMove || actions.onDelete || actions.onRestore);

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {header("name", "Name")}
            {showFolder && <th scope="col">Folder</th>}
            {header("size", "Size")}
            {header("date", "Uploaded")}
            {showStatus && <th scope="col">Status</th>}
            <th scope="col" className="th-actions">
              Actions
            </th>
          </tr>
        </thead>
        <tbody>
          {documents.map((doc) => {
            const dl = downloads[doc.id];
            return (
              <tr key={doc.id}>
                <td data-label="Name">
                  <span className="doc-name">
                    <span className="doc-ext" aria-hidden="true">
                      {doc.extension.toUpperCase() || "FILE"}
                    </span>
                    <span>
                      <span className="doc-title">{doc.displayName}</span>
                      {doc.description && <span className="doc-desc">{doc.description}</span>}
                      {doc.uploadedBy && <span className="doc-desc">by {doc.uploadedBy.fullName}</span>}
                    </span>
                  </span>
                </td>
                {showFolder && <td data-label="Folder">{doc.folderName ?? "—"}</td>}
                <td data-label="Size">{formatBytes(doc.sizeBytes)}</td>
                <td data-label="Uploaded" title={formatDateTime(doc.availableAt ?? doc.createdAt)}>
                  {formatDate(doc.availableAt ?? doc.createdAt)}
                </td>
                {showStatus && (
                  <td data-label="Status">
                    <Badge tone={STATUS_TONE[doc.status] ?? "neutral"}>{doc.status.replace(/_/g, " ").toLowerCase()}</Badge>
                    {doc.status === "DELETED" && doc.purgeAfter && <span className="doc-desc">purges {formatDate(doc.purgeAfter)}</span>}
                  </td>
                )}
                <td data-label="Actions" className="td-actions">
                  <div className="row-actions">
                    {doc.canDownload && (
                      <Button size="sm" variant="primary" onClick={() => download(doc)} loading={dl?.status === "preparing"} aria-label={`Download ${doc.displayName}`}>
                        Download
                      </Button>
                    )}
                    {hasManage && doc.status === "AVAILABLE" && (
                      <>
                        {actions.onRename && (
                          <Button size="sm" variant="ghost" onClick={() => actions.onRename!(doc)} aria-label={`Rename ${doc.displayName}`}>
                            Rename
                          </Button>
                        )}
                        {actions.onMove && (
                          <Button size="sm" variant="ghost" onClick={() => actions.onMove!(doc)} aria-label={`Move ${doc.displayName}`}>
                            Move
                          </Button>
                        )}
                        {actions.onDelete && (
                          <Button size="sm" variant="ghost" className="text-danger" onClick={() => actions.onDelete!(doc)} aria-label={`Delete ${doc.displayName}`}>
                            Delete
                          </Button>
                        )}
                      </>
                    )}
                    {actions.onDelete && doc.status === "MISSING_OBJECT" && (
                      <Button size="sm" variant="ghost" className="text-danger" onClick={() => actions.onDelete!(doc)}>
                        Delete
                      </Button>
                    )}
                    {actions.onRestore && doc.status === "DELETED" && (
                      <Button size="sm" variant="ghost" onClick={() => actions.onRestore!(doc)} aria-label={`Restore ${doc.displayName}`}>
                        Restore
                      </Button>
                    )}
                  </div>
                  {dl && dl.status !== "preparing" && (
                    <span className={`download-status ${dl.status === "failed" ? "text-danger" : ""}`} role="status">
                      {dl.status === "started" ? "Download started" : dl.message}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
