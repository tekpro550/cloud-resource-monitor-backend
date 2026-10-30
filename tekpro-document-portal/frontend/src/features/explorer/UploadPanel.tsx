import { useRef, useState, type DragEvent } from "react";
import { Button, ProgressBar } from "../../components/ui";
import { errorMessage } from "../../services/api";
import { isCancelled, startUpload, type UploadHandle } from "../../services/uploader";
import { formatBytes } from "../../utils/format";

type Status = "uploading" | "verifying" | "done" | "failed" | "cancelled";
interface UploadItem {
  id: string;
  file: File;
  loaded: number;
  status: Status;
  error?: string;
  handle?: UploadHandle;
}

let seq = 0;

/**
 * Drag-and-drop / file-picker uploader. Files go straight from the browser to
 * object storage using short-lived pre-signed requests issued by the API.
 */
export function UploadPanel({ customerId, folderId, folderName, onUploaded }: { customerId: string; folderId: string | null; folderName?: string; onUploaded: () => void }) {
  const [items, setItems] = useState<UploadItem[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const update = (id: string, patch: Partial<UploadItem>) => setItems((list) => list.map((i) => (i.id === id ? { ...i, ...patch } : i)));

  const begin = (file: File, existingId?: string) => {
    if (!folderId) return;
    const id = existingId ?? `u${++seq}`;
    const handle = startUpload(customerId, folderId, file, ({ loaded, total }) => {
      update(id, { loaded, status: loaded >= total ? "verifying" : "uploading" });
    });
    const item: UploadItem = { id, file, loaded: 0, status: "uploading", handle };
    setItems((list) => (existingId ? list.map((i) => (i.id === id ? item : i)) : [...list, item]));
    handle.promise
      .then(() => {
        update(id, { status: "done", loaded: file.size });
        onUploaded();
      })
      .catch((err) => update(id, isCancelled(err) ? { status: "cancelled" } : { status: "failed", error: errorMessage(err) }));
  };

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    Array.from(files).forEach((f) => begin(f));
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };

  const active = items.some((i) => i.status === "uploading" || i.status === "verifying");

  return (
    <section className="upload-panel" aria-label="Upload documents">
      {folderId ? (
        <div
          className={`dropzone ${dragging ? "dropzone-active" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <p>
            Drag files here to upload to <strong>{folderName ?? "this folder"}</strong>, or
          </p>
          <Button variant="primary" size="sm" onClick={() => inputRef.current?.click()}>
            Choose files
          </Button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="visually-hidden"
            aria-label="Choose files to upload"
            data-testid="file-input"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      ) : (
        <p className="muted small">Select a folder to upload documents.</p>
      )}

      {items.length > 0 && (
        <ul className="upload-list" aria-live="polite">
          {items.map((item) => {
            const pct = item.file.size ? item.loaded / item.file.size : item.status === "done" ? 1 : 0;
            return (
              <li key={item.id} className={`upload-item upload-${item.status}`}>
                <div className="upload-item-head">
                  <span className="upload-name" title={item.file.name}>
                    {item.file.name}
                  </span>
                  <span className="upload-size">{formatBytes(item.file.size)}</span>
                </div>
                {(item.status === "uploading" || item.status === "verifying") && <ProgressBar value={pct} label={`Uploading ${item.file.name}`} />}
                <div className="upload-item-foot">
                  <span className="upload-status">
                    {item.status === "uploading" && `${Math.round(pct * 100)}% uploaded`}
                    {item.status === "verifying" && "Verifying…"}
                    {item.status === "done" && "Uploaded"}
                    {item.status === "cancelled" && "Cancelled"}
                    {item.status === "failed" && `Failed: ${item.error}`}
                  </span>
                  {(item.status === "uploading" || item.status === "verifying") && (
                    <Button size="sm" variant="ghost" onClick={() => item.handle?.cancel()}>
                      Cancel
                    </Button>
                  )}
                  {(item.status === "failed" || item.status === "cancelled") && (
                    <Button size="sm" variant="ghost" onClick={() => begin(item.file, item.id)}>
                      Retry
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {items.length > 0 && !active && (
        <Button size="sm" variant="ghost" onClick={() => setItems([])}>
          Clear list
        </Button>
      )}
    </section>
  );
}
