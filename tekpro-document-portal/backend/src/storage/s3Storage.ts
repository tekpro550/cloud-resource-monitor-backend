import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutBucketCorsCommand,
  PutBucketEncryptionCommand,
  PutBucketOwnershipControlsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@aws-sdk/types";
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
export interface S3AdapterOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle: boolean;
  requestTimeoutMs: number;
  /** Static keys, or a provider returning temporary credentials (e.g. from STS AssumeRole). */
  credentials?: AwsCredentialIdentity | AwsCredentialIdentityProvider;
  accessKeyId?: string;
  secretAccessKey?: string;
  /**
   * When set, connectivity is checked with a prefix-scoped ListObjectsV2 instead of
   * HeadBucket, so credentials limited to one customer prefix can pass the check.
   */
  connectivityPrefix?: string;
  name?: string;
}

export class S3StorageAdapter implements StorageAdapter {
  readonly name: string;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly connectivityPrefix?: string;

  constructor(cfg: S3AdapterOptions) {
    this.name = cfg.name ?? "s3";
    this.bucket = cfg.bucket;
    this.connectivityPrefix = cfg.connectivityPrefix;
    this.client = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: cfg.credentials ?? { accessKeyId: cfg.accessKeyId!, secretAccessKey: cfg.secretAccessKey! },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      maxAttempts: 3,
      requestHandler: { requestTimeout: cfg.requestTimeoutMs, connectionTimeout: Math.min(cfg.requestTimeoutMs, 10_000) },
    });
  }

  async checkConnectivity(): Promise<void> {
    if (this.connectivityPrefix) {
      await this.run("ListObjectsV2", () =>
        this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: this.connectivityPrefix, MaxKeys: 1 })),
      );
      return;
    }
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

  async createBucket(opts: { region: string; corsOrigin: string }): Promise<void> {
    const Bucket = this.bucket;
    await this.run("CreateBucket", () =>
      this.client.send(
        new CreateBucketCommand({
          Bucket,
          ObjectOwnership: "BucketOwnerEnforced",
          // us-east-1 is the default location and must not be named explicitly.
          ...(opts.region === "us-east-1" ? {} : { CreateBucketConfiguration: { LocationConstraint: opts.region as never } }),
        }),
      ),
    );
    await this.run("PutPublicAccessBlock", () =>
      this.client.send(
        new PutPublicAccessBlockCommand({
          Bucket,
          PublicAccessBlockConfiguration: { BlockPublicAcls: true, IgnorePublicAcls: true, BlockPublicPolicy: true, RestrictPublicBuckets: true },
        }),
      ),
    );
    await this.run("PutBucketOwnershipControls", () =>
      this.client.send(new PutBucketOwnershipControlsCommand({ Bucket, OwnershipControls: { Rules: [{ ObjectOwnership: "BucketOwnerEnforced" }] } })),
    );
    await this.run("PutBucketEncryption", () =>
      this.client.send(
        new PutBucketEncryptionCommand({
          Bucket,
          ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: "AES256" } }] },
        }),
      ),
    );
    await this.run("PutBucketVersioning", () =>
      this.client.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: "Enabled" } })),
    );
    await this.run("PutBucketCors", () =>
      this.client.send(
        new PutBucketCorsCommand({
          Bucket,
          CORSConfiguration: {
            CORSRules: [
              { AllowedOrigins: [opts.corsOrigin], AllowedMethods: ["PUT", "GET", "HEAD"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag"], MaxAgeSeconds: 3000 },
            ],
          },
        }),
      ),
    );
  }

  async deleteBucket(opts: { prefix: string }): Promise<void> {
    const Bucket = this.bucket;
    let KeyMarker: string | undefined;
    let VersionIdMarker: string | undefined;
    do {
      const page = await this.run("ListObjectVersions", () =>
        this.client.send(new ListObjectVersionsCommand({ Bucket, Prefix: opts.prefix, KeyMarker, VersionIdMarker, MaxKeys: 1000 })),
      );
      const objects = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]
        .filter((v) => v.Key)
        .map((v) => ({ Key: v.Key!, VersionId: v.VersionId }));
      if (objects.length) {
        const res = await this.run("DeleteObjects", () =>
          this.client.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects, Quiet: true } })),
        );
        if (res.Errors?.length) throw new StorageError("ACCESS_DENIED", `Storage DeleteObjects failed for ${res.Errors.length} object(s)`, false);
      }
      KeyMarker = page.IsTruncated ? page.NextKeyMarker : undefined;
      VersionIdMarker = page.IsTruncated ? page.NextVersionIdMarker : undefined;
    } while (KeyMarker);
    await this.run("DeleteBucket", () => this.client.send(new DeleteBucketCommand({ Bucket })));
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
  if (name === "BucketAlreadyOwnedByYou") kind = "BUCKET_EXISTS";
  else if (name === "BucketAlreadyExists") kind = "BUCKET_NAME_TAKEN";
  else if (name === "BucketNotEmpty") kind = "BUCKET_NOT_EMPTY";
  else if (["NoSuchKey", "NotFound", "NoSuchUpload", "NoSuchBucket"].includes(name) || status === 404) kind = "NOT_FOUND";
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
