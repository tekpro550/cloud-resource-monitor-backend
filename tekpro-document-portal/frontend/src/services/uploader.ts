import type { DocumentItem } from "../types/api";
import { ApiError } from "./api";
import { uploadsApi } from "./endpoints";

export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface UploadHandle {
  promise: Promise<DocumentItem>;
  cancel: () => void;
}

class CancelledError extends Error {
  constructor() {
    super("Upload cancelled");
    this.name = "CancelledError";
  }
}
export const isCancelled = (e: unknown) => e instanceof CancelledError;

const PART_CONCURRENCY = 3;
const PART_RETRIES = 3;
const URL_BATCH = 20;

/**
 * PUTs a Blob directly to object storage with progress events. Bytes go from the
 * browser to storage; they never pass through the application server. File.slice
 * creates lazy views, so large files are never read fully into memory.
 */
function putBlob(
  url: string,
  blob: Blob,
  headers: Record<string, string>,
  onProgress: (loaded: number) => void,
  register: (abort: () => void) => void,
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader("ETag"));
      else reject(new Error(`Storage rejected the upload (HTTP ${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Network error while uploading to storage"));
    xhr.onabort = () => reject(new CancelledError());
    register(() => xhr.abort());
    xhr.send(blob);
  });
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function startUpload(
  customerId: string,
  folderId: string,
  file: File,
  onProgress: (p: UploadProgress) => void,
): UploadHandle {
  let cancelled = false;
  let uploadId: string | null = null;
  const aborters = new Set<() => void>();
  const register = (fn: () => void) => aborters.add(fn);

  const run = async (): Promise<DocumentItem> => {
    const init = await uploadsApi.initiate(customerId, { folderId, filename: file.name, sizeBytes: file.size });
    uploadId = init.uploadId;
    if (cancelled) throw new CancelledError();

    if (init.mode === "SINGLE" && init.upload) {
      await putBlob(init.upload.url, file, init.upload.headers, (loaded) => onProgress({ loaded, total: file.size }), register);
      return uploadsApi.complete(init.uploadId);
    }

    const partSize = init.partSize!;
    const partCount = init.partCount!;
    const loadedByPart = new Map<number, number>();
    const report = () => onProgress({ loaded: [...loadedByPart.values()].reduce((a, b) => a + b, 0), total: file.size });
    const etags = new Map<number, string>();
    const urlCache = new Map<number, string>();

    const urlFor = async (partNumber: number, refresh = false) => {
      if (refresh || !urlCache.has(partNumber)) {
        const batch = Array.from({ length: URL_BATCH }, (_, i) => partNumber + i).filter((n) => n <= partCount && (refresh ? n === partNumber : !urlCache.has(n)));
        const { parts } = await uploadsApi.partUrls(init.uploadId, batch);
        for (const p of parts) urlCache.set(p.partNumber, p.url);
      }
      return urlCache.get(partNumber)!;
    };

    const uploadPart = async (partNumber: number) => {
      const start = (partNumber - 1) * partSize;
      const blob = file.slice(start, Math.min(start + partSize, file.size));
      for (let attempt = 1; ; attempt++) {
        if (cancelled) throw new CancelledError();
        try {
          const url = await urlFor(partNumber, attempt > 1);
          const etag = await putBlob(url, blob, {}, (loaded) => {
            loadedByPart.set(partNumber, loaded);
            report();
          }, register);
          if (!etag) throw new Error("Storage did not return an ETag. Check the bucket CORS ExposeHeaders setting.");
          etags.set(partNumber, etag);
          loadedByPart.set(partNumber, blob.size);
          report();
          return;
        } catch (err) {
          if (isCancelled(err) || attempt >= PART_RETRIES) throw err;
          loadedByPart.set(partNumber, 0);
          await delay(1000 * 2 ** (attempt - 1));
        }
      }
    };

    // Fixed-size worker pool over the part numbers.
    let next = 1;
    const worker = async () => {
      while (next <= partCount) {
        const n = next++;
        await uploadPart(n);
      }
    };
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, partCount) }, worker));
    return uploadsApi.complete(
      init.uploadId,
      [...etags.entries()].map(([partNumber, etag]) => ({ partNumber, etag })),
    );
  };

  const promise = run().catch(async (err) => {
    // Best effort: tell the server so it can release storage immediately.
    // Expired or abandoned sessions are otherwise cleaned up by the maintenance job.
    if (uploadId && (isCancelled(err) || !(err instanceof ApiError))) {
      await uploadsApi.abort(uploadId).catch(() => undefined);
    }
    throw err;
  });

  return {
    promise,
    cancel: () => {
      cancelled = true;
      for (const abort of aborters) abort();
    },
  };
}
