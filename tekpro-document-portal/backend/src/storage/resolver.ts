import { AssumeRoleCommand, GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from "@aws-sdk/types";
import type { PrismaClient, StorageConnector } from "@prisma/client";
import type { AppConfig } from "../config/env.js";
import { decryptSecret } from "../modules/storageConnectors/secrets.js";
import { customerPrefix } from "../modules/storageConnectors/policies.js";
import { browserOrigins } from "../modules/storageConnectors/validation.js";
import { AppError } from "../utils/errors.js";
import { mapS3Error, S3StorageAdapter } from "./s3Storage.js";
import { StorageError, type StorageAdapter } from "./storage.js";

/** Builds an adapter for a connector. Replaceable in tests. */
export type ConnectorAdapterFactory = (connector: StorageConnector) => StorageAdapter;

/** Where an object lives: the platform bucket, or one customer connector. */
export interface StorageTarget {
  adapter: StorageAdapter;
  connectorId: string | null;
}

/**
 * Resolves the storage that holds a customer's (or a document's) objects.
 *
 * - Documents remember the connector they were written with (`storageConnectorId`),
 *   so reads/deletes always go to the right bucket even after the customer's
 *   configuration changes.
 * - New uploads use the customer's connector when one exists. If it exists but is
 *   not ACTIVE, uploads are refused: there is no silent fallback to Tekpro storage.
 */
export class StorageResolver {
  private readonly cache = new Map<string, { version: number; adapter: StorageAdapter }>();
  private originCache?: { at: number; origins: string[] };
  private sts?: STSClient;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly config: AppConfig,
    readonly platform: StorageAdapter,
    private readonly factory?: ConnectorAdapterFactory,
  ) {}

  async uploadTarget(customerId: string): Promise<StorageTarget> {
    const connector = await this.prisma.storageConnector.findUnique({ where: { customerId } });
    if (!connector) return { adapter: this.platform, connectorId: null };
    if (connector.status !== "ACTIVE") {
      throw new AppError(
        409,
        "INVALID_STATE",
        "This customer's own storage connection is not active. A Super Admin must verify the storage connection before documents can be uploaded.",
      );
    }
    return { adapter: this.forConnector(connector), connectorId: connector.id };
  }

  async forDocument(doc: { storageConnectorId: string | null }): Promise<StorageAdapter> {
    if (!doc.storageConnectorId) return this.platform;
    const connector = await this.prisma.storageConnector.findUnique({ where: { id: doc.storageConnectorId } });
    if (!connector) throw new StorageError("UNAVAILABLE", "Storage connector not found", false);
    return this.forConnector(connector);
  }

  /** Cached per connector; any configuration change (updatedAt) builds a fresh client. */
  forConnector(connector: StorageConnector): StorageAdapter {
    const version = connector.updatedAt.getTime();
    const hit = this.cache.get(connector.id);
    if (hit && hit.version === version) return hit.adapter;
    const adapter = this.factory ? this.factory(connector) : this.buildAdapter(connector);
    this.cache.set(connector.id, { version, adapter });
    return adapter;
  }

  invalidate(connectorId: string): void {
    this.cache.delete(connectorId);
    this.originCache = undefined;
  }

  /** All storage locations, for reconciliation. */
  async allTargets(): Promise<(StorageTarget & { prefix: string; label: string })[]> {
    const connectors = await this.prisma.storageConnector.findMany();
    return [
      { adapter: this.platform, connectorId: null, prefix: "customers/", label: "platform" },
      ...connectors.map((c) => ({
        adapter: this.forConnector(c),
        connectorId: c.id,
        prefix: customerPrefix(c.customerId),
        label: `connector:${c.bucket}`,
      })),
    ];
  }

  /** Browser origins of every connector in use (for the CSP connect-src), cached for 60 s. */
  async connectorOrigins(): Promise<string[]> {
    if (this.originCache && Date.now() - this.originCache.at < 60_000) return this.originCache.origins;
    const connectors = await this.prisma.storageConnector.findMany({ where: { status: { in: ["ACTIVE", "PENDING_VERIFICATION", "FAILED"] } } });
    const origins = [...new Set(connectors.flatMap(browserOrigins))];
    this.originCache = { at: Date.now(), origins };
    return origins;
  }

  /** Identity the portal uses for sts:AssumeRole (shown to customers for their trust policy). */
  async portalIdentity(): Promise<{ arn: string; account: string }> {
    try {
      const res = await this.stsClient().send(new GetCallerIdentityCommand({}));
      return { arn: res.Arn!, account: res.Account! };
    } catch (err) {
      throw mapS3Error("GetCallerIdentity", err);
    }
  }

  private stsClient(): STSClient {
    this.sts ??= new STSClient({
      region: this.config.connectors.stsRegion,
      endpoint: this.config.connectors.stsEndpoint,
      credentials: this.config.connectors.assumeRoleCredentials,
      maxAttempts: 3,
    });
    return this.sts;
  }

  private buildAdapter(c: StorageConnector): S3StorageAdapter {
    let credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider;
    if (c.authType === "ACCESS_KEY") {
      const key = this.config.connectors.encryptionKey;
      if (!key) throw new StorageError("UNAVAILABLE", "CONNECTOR_ENCRYPTION_KEY is not configured", false);
      credentials = { accessKeyId: c.accessKeyId!, secretAccessKey: decryptSecret(c.secretCiphertext!, key, c.id) };
    } else {
      credentials = this.assumeRoleProvider(c);
    }
    return new S3StorageAdapter({
      name: `connector:${c.bucket}`,
      bucket: c.bucket,
      region: c.region,
      endpoint: c.endpoint ?? undefined,
      forcePathStyle: c.forcePathStyle,
      requestTimeoutMs: this.config.storage.requestTimeoutMs,
      credentials,
      // Customer credentials are scoped to their prefix; HeadBucket would be denied.
      connectivityPrefix: customerPrefix(c.customerId),
    });
  }

  /**
   * Temporary credentials from the customer's role. The expiration reported to the
   * SDK is moved 25 minutes earlier so credentials are always refreshed well before
   * any pre-signed URL (max 15 minutes) could outlive them.
   */
  private assumeRoleProvider(c: StorageConnector): AwsCredentialIdentityProvider {
    const duration = this.config.connectors.roleSessionSeconds;
    const marginMs = Math.min(25 * 60_000, (duration * 1000) / 2);
    return async () => {
      try {
        const res = await this.stsClient().send(
          new AssumeRoleCommand({
            RoleArn: c.roleArn!,
            ExternalId: c.externalId,
            RoleSessionName: `tekpro-portal-${c.customerId.slice(0, 8)}`,
            DurationSeconds: duration,
          }),
        );
        const cr = res.Credentials!;
        return {
          accessKeyId: cr.AccessKeyId!,
          secretAccessKey: cr.SecretAccessKey!,
          sessionToken: cr.SessionToken,
          expiration: new Date(cr.Expiration!.getTime() - marginMs),
        };
      } catch (err) {
        throw mapS3Error("AssumeRole", err);
      }
    };
  }
}
