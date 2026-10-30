import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AppConfig } from "../config/env.js";
import {
  StorageError,
  type CompletedPart,
  type ListedObject,
  type ObjectHead,
  type PresignedRequest,
  type StorageAdapter,
  type StorageErrorKind,
} from "./storage.js";

/**
 * Amazon Lightsail Object Storage adapter (S3-compatible API, AWS SDK v3).
 *
 * Lightsail buckets are served by the regional S3 endpoint
 * (https://s3.<region>.amazonaws.com) and support SigV4 pre-signed URLs and the
 * multipart upload API. STORAGE_ENDPOINT is still configurable so the adapter can
 * be pointed at another S3-compatible service for testing.
 *
 * Flexible checksums are restricted to WHEN_REQUIRED: recent SDK versions
 * otherwise add x-amz-checksum-* parameters to pre-signed PUT URLs, which a
 * browser cannot satisfy and which some S3-compatible services reject.
 */
export class S3StorageAdapter implements StorageAdapter {
  readonly name = "s3";
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(cfg: AppConfig["storage"]) {
    this.bucket = cfg.bucket;
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId!, secretAccessKey: cfg.secretAccessKey! },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
      requestHandler: { requestTimeout: cfg.requestTimeoutMs, connectionTimeout: Math.min(cfg.requestTimeoutMs, 10_000) },
    });
  }

  async checkConnectivity(): Promise<void> {
    await this.run("HeadBucket", () => this.client.send(new HeadBucketCommand({ Bucket: this.bucket })));
  }

  async presignPut(key: string, opts: { contentType: string; contentLength: number; expiresInSeconds: number }) {
    const cmd = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: opts.contentType,
      ContentLength: opts.contentLength,
    });
    // Content-Type and Content-Length are signed headers, so the upload must match
    // the size and type that were authorised at initiation.
    const url = await this.run("PresignPut", () =>
      getSignedUrl(this.client, cmd, {
        expiresIn: opts.expiresInSeconds,
        signableHeaders: new Set(["content-type", "content-length"]),
      }),
    );
    return this.presigned(url, "PUT", { "Content-Type": opts.contentType }, opts.expiresInSeconds);
  }

  async presignGet(key: string, opts: { expiresInSeconds: number; contentDisposition: string; contentType: string }) {
    const cmd = new GetObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ResponseContentDisposition: opts.contentDisposition,
      ResponseContentType: opts.contentType,
      ResponseCacheControl: "private, no-store",
    });
    const url = await this.run("PresignGet", () => getSignedUrl(this.client, cmd, { expiresIn: opts.expiresInSeconds }));
    return this.presigned(url, "GET", {}, opts.expiresInSeconds);
  }

  async createMultipartUpload(key: string, opts: { contentType: string }): Promise<string> {
    const res = await this.run("CreateMultipartUpload", () =>
      this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: opts.contentType })),
    );
    if (!res.UploadId) throw new StorageError("UNKNOWN", "Storage did not return a multipart upload id", true);
    return res.UploadId;
  }

  async presignUploadPart(key: string, uploadId: string, partNumber: number, expiresInSeconds: number) {
    const cmd = new UploadPartCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, PartNumber: partNumber });
    const url = await this.run("PresignUploadPart", () => getSignedUrl(this.client, cmd, { expiresIn: expiresInSeconds }));
    return this.presigned(url, "PUT", {}, expiresInSeconds);
  }

  async completeMultipartUpload(key: string, uploadId: string, parts: CompletedPart[]): Promise<void> {
    await this.run("CompleteMultipartUpload", () =>
      this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: {
            Parts: [...parts].sort((a, b) => a.partNumber - b.partNumber).map((p) => ({ PartNumber: p.partNumber, ETag: p.etag })),
          },
        }),
      ),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.run("AbortMultipartUpload", () =>
        this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })),
      );
    } catch (err) {
      // Already completed or aborted: nothing left to clean up.
      if (err instanceof StorageError && err.kind === "NOT_FOUND") return;
      throw err;
    }
  }

  async headObject(key: string): Promise<ObjectHead | null> {
    try {
      const res = await this.run("HeadObject", () => this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })));
      return {
        sizeBytes: Number(res.ContentLength ?? 0),
        etag: res.ETag?.replace(/"/g, ""),
        contentType: res.ContentType,
        lastModified: res.LastModified,
      };
    } catch (err) {
      if (err instanceof StorageError && err.kind === "NOT_FOUND") return null;
      throw err;
    }
  }

  async readObjectPrefix(key: string, length: number): Promise<Uint8Array> {
    const res = await this.run("GetObjectRange", () =>
      this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key, Range: `bytes=0-${Math.max(0, length - 1)}` })),
    );
    if (!res.Body) return new Uint8Array();
    const bytes = await res.Body.transformToByteArray();
    return bytes.subarray(0, length);
  }

  async deleteObject(key: string): Promise<void> {
    await this.run("DeleteObject", () => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key })));
  }

  async listObjects(prefix: string, continuationToken?: string): Promise<{ objects: ListedObject[]; nextToken?: string }> {
    const res = await this.run("ListObjectsV2", () =>
      this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: continuationToken, MaxKeys: 1000 }),
      ),
    );
    return {
      objects: (res.Contents ?? []).map((o) => ({ key: o.Key!, sizeBytes: Number(o.Size ?? 0), lastModified: o.LastModified })),
      nextToken: res.IsTruncated ? res.NextContinuationToken : undefined,
    };
  }

  private presigned(url: string, method: "PUT" | "GET", headers: Record<string, string>, ttl: number): PresignedRequest {
    return { url, method, headers, expiresAt: new Date(Date.now() + ttl * 1000) };
  }

  private async run<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw mapS3Error(operation, err);
    }
  }
}

export function mapS3Error(operation: string, err: unknown): StorageError {
  if (err instanceof StorageError) return err;
  const e = err as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const name = e?.name ?? e?.code ?? "UnknownError";
  const status = err instanceof S3ServiceException ? err.$metadata?.httpStatusCode : e?.$metadata?.httpStatusCode;

  let kind: StorageErrorKind = "UNKNOWN";
  let retryable = false;
  if (["NoSuchKey", "NotFound", "NoSuchUpload", "NoSuchBucket"].includes(name) || status === 404) kind = "NOT_FOUND";
  else if (name === "SignatureDoesNotMatch") kind = "INVALID_SIGNATURE";
  else if (name === "ExpiredToken" || name === "RequestExpired") kind = "EXPIRED";
  else if (name === "AccessDenied" || name === "Forbidden" || name === "InvalidAccessKeyId" || status === 403) kind = "ACCESS_DENIED";
  else if (["InvalidPart", "InvalidPartOrder", "EntityTooSmall", "EntityTooLarge"].includes(name)) kind = "INCOMPLETE_UPLOAD";
  else if (["TimeoutError", "RequestTimeout", "ETIMEDOUT", "ECONNRESET", "AbortError"].includes(name)) {
    kind = "TIMEOUT";
    retryable = true;
  } else if (["ServiceUnavailable", "SlowDown", "InternalError", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(name) || (status && status >= 500)) {
    kind = "UNAVAILABLE";
    retryable = true;
  } else if (status === 400) kind = "INVALID_REQUEST";

  return new StorageError(kind, `Storage ${operation} failed (${name}${status ? `, HTTP ${status}` : ""})`, retryable);
}
