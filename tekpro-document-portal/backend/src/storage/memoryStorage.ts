import { createHash, randomUUID } from "node:crypto";
import {
  StorageError,
  type CompletedPart,
  type ListedObject,
  type ObjectHead,
  type PresignedRequest,
  type StorageAdapter,
} from "./storage.js";

type Operation =
  | "checkConnectivity"
  | "presignPut"
  | "presignGet"
  | "createMultipartUpload"
  | "presignUploadPart"
  | "completeMultipartUpload"
  | "abortMultipartUpload"
  | "headObject"
  | "readObjectPrefix"
  | "deleteObject"
  | "listObjects"
  | "createBucket"
  | "deleteBucket";

interface StoredObject {
  body: Uint8Array;
  contentType: string;
  etag: string;
  lastModified: Date;
}

/**
 * In-memory storage used ONLY by automated tests (STORAGE_DRIVER=memory is
 * rejected in production). It mirrors the S3 semantics the application depends
 * on - including multipart part ETags - and lets tests inject failures and
 * simulate "browser" uploads against the issued pre-signed requests.
 */
export class MemoryStorageAdapter implements StorageAdapter {
  readonly name: string;
  readonly objects = new Map<string, StoredObject>();
  private readonly multipart = new Map<string, { key: string; contentType: string; parts: Map<number, StoredObject> }>();
  private readonly failures = new Map<Operation, StorageError>();
  readonly issuedUrls: string[] = [];
  /** Simulated bucket CORS: origin allowed for browser requests, and whether ETag is exposed. */
  cors: { allowOrigin: string | null; exposeEtag: boolean } = { allowOrigin: "*", exposeEtag: true };

  constructor(readonly host = "memory-storage.invalid") {
    this.name = host === "memory-storage.invalid" ? "memory" : `memory:${host}`;
  }

  failNext(op: Operation, kind: StorageError["kind"] = "UNAVAILABLE"): void {
    this.failures.set(op, new StorageError(kind, `Simulated ${kind} during ${op}`, kind === "UNAVAILABLE"));
  }

  private maybeFail(op: Operation): void {
    const err = this.failures.get(op);
    if (err) {
      this.failures.delete(op);
      throw err;
    }
  }

  /** Simulates the browser performing a pre-signed PUT. */
  putObject(key: string, body: Uint8Array | string, contentType = "application/octet-stream"): string {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const etag = createHash("md5").update(bytes).digest("hex");
    this.objects.set(key, { body: bytes, contentType, etag, lastModified: new Date() });
    return etag;
  }

  /** Simulates the browser uploading one multipart part. */
  uploadPart(uploadId: string, partNumber: number, body: Uint8Array | string): string {
    const mp = this.multipart.get(uploadId);
    if (!mp) throw new StorageError("NOT_FOUND", "No such upload", false);
    const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
    const etag = createHash("md5").update(bytes).digest("hex");
    mp.parts.set(partNumber, { body: bytes, contentType: mp.contentType, etag, lastModified: new Date() });
    return etag;
  }

  hasMultipart(uploadId: string): boolean {
    return this.multipart.has(uploadId);
  }

  async checkConnectivity(): Promise<void> {
    this.maybeFail("checkConnectivity");
  }

  /** Set by createBucket; tests may set `bucketExists` to simulate an existing bucket. */
  bucketExists = false;
  createdBucket: { region: string; corsOrigin: string } | null = null;

  async createBucket(opts: { region: string; corsOrigin: string }): Promise<void> {
    this.maybeFail("createBucket");
    if (this.bucketExists) throw new StorageError("BUCKET_EXISTS", "Storage CreateBucket failed (BucketAlreadyOwnedByYou)", false);
    this.bucketExists = true;
    this.createdBucket = opts;
    this.cors = { allowOrigin: opts.corsOrigin, exposeEtag: true };
  }

  bucketDeleted = false;

  async deleteBucket(opts: { prefix: string }): Promise<void> {
    this.maybeFail("deleteBucket");
    for (const key of [...this.objects.keys()]) if (key.startsWith(opts.prefix)) this.objects.delete(key);
    if (this.objects.size) throw new StorageError("BUCKET_NOT_EMPTY", "Storage DeleteBucket failed (BucketNotEmpty)", false);
    this.bucketExists = false;
    this.bucketDeleted = true;
  }

  private presigned(method: "PUT" | "GET", key: string, ttl: number, extra: string, headers: Record<string, string> = {}): PresignedRequest {
    const url = `https://${this.host}/${encodeURI(key)}?X-Amz-Expires=${ttl}&X-Amz-Signature=${randomUUID()}${extra}`;
    this.issuedUrls.push(url);
    return { url, method, headers, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  async presignPut(key: string, opts: { contentType: string; contentLength: number; expiresInSeconds: number }) {
    this.maybeFail("presignPut");
    return this.presigned("PUT", key, opts.expiresInSeconds, "", { "Content-Type": opts.contentType });
  }

  async presignGet(key: string, opts: { expiresInSeconds: number; contentDisposition: string; contentType: string }) {
    this.maybeFail("presignGet");
    return this.presigned(
      "GET",
      key,
      opts.expiresInSeconds,
      `&response-content-disposition=${encodeURIComponent(opts.contentDisposition)}`,
    );
  }

  async createMultipartUpload(key: string, opts: { contentType: string }): Promise<string> {
    this.maybeFail("createMultipartUpload");
    const id = randomUUID();
    this.multipart.set(id, { key, contentType: opts.contentType, parts: new Map() });
    return id;
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number, ttl: number) {
    this.maybeFail("presignUploadPart");
    if (!this.multipart.has(uploadId)) throw new StorageError("NOT_FOUND", "No such upload", false);
    return this.presigned("PUT", key, ttl, `&partNumber=${partNumber}&uploadId=${uploadId}`);
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
    this.maybeFail("completeMultipartUpload");
    const mp = this.multipart.get(uploadId);
    if (!mp || mp.key !== key) throw new StorageError("NOT_FOUND", "No such upload", false);
    const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
    const chunks: Uint8Array[] = [];
    for (const p of sorted) {
      const stored = mp.parts.get(p.partNumber);
      if (!stored || stored.etag !== p.etag.replace(/"/g, "")) {
        throw new StorageError("INCOMPLETE_UPLOAD", "Storage CompleteMultipartUpload failed (InvalidPart)", false);
      }
      chunks.push(stored.body);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const body = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      body.set(c, offset);
      offset += c.length;
    }
    const etag = `${createHash("md5").update(body).digest("hex")}-${sorted.length}`;
    this.objects.set(key, { body, contentType: mp.contentType, etag, lastModified: new Date() });
    this.multipart.delete(uploadId);
  }

  async abortMultipartUpload(_key: string, uploadId: string): Promise<void> {
    this.maybeFail("abortMultipartUpload");
    this.multipart.delete(uploadId);
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    this.maybeFail("headObject");
    const o = this.objects.get(key);
    return o ? { sizeBytes: o.body.length, etag: o.etag, contentType: o.contentType, lastModified: o.lastModified } : null;
  }

  async readObjectPrefix(key: string, length: number): Promise<Uint8Array> {
    this.maybeFail("readObjectPrefix");
    const o = this.objects.get(key);
    if (!o) throw new StorageError("NOT_FOUND", "Storage GetObjectRange failed (NoSuchKey)", false);
    return o.body.subarray(0, length);
  }

  async deleteObject(key: string): Promise<void> {
    this.maybeFail("deleteObject");
    this.objects.delete(key);
  }

  async listObjects(prefix: string): Promise<{ objects: ListedObject[]; nextToken?: string }> {
    this.maybeFail("listObjects");
    const objects = [...this.objects.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, o]) => ({ key, sizeBytes: o.body.length, lastModified: o.lastModified }));
    return { objects };
  }
}
