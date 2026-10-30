import { randomUUID } from "node:crypto";
import { Prisma, type StorageConnector } from "@prisma/client";
import { Router } from "express";
import { z } from "zod";
import { principal, requireRoles } from "../../middleware/auth.js";
import type { Services } from "../../services.js";
import { randomToken } from "../../utils/crypto.js";
import { AppError, badRequest, conflict, notFound } from "../../utils/errors.js";
import { AuditAction } from "../audit/audit.service.js";
import { corsConfiguration, customerPrefix, permissionsPolicy, trustPolicy, trustPrincipalFromCallerArn } from "./policies.js";
import { encryptSecret, maskKeyId } from "./secrets.js";
import { connectorInputSchema, validateEndpoint } from "./validation.js";
import { verifyStorage, type FetchLike } from "./verifier.js";

const customerParam = z.object({ customerId: z.uuid() });
const LOCATION_FIELDS = ["provider", "bucket", "region", "endpoint", "forcePathStyle"] as const;

/** Public view of a connector. Secrets are never returned. */
function serializeConnector(c: StorageConnector, documentCount: number) {
  return {
    id: c.id,
    customerId: c.customerId,
    provider: c.provider,
    bucket: c.bucket,
    region: c.region,
    endpoint: c.endpoint,
    forcePathStyle: c.forcePathStyle,
    authType: c.authType,
    roleArn: c.roleArn,
    externalId: c.externalId,
    accessKeyIdMasked: maskKeyId(c.accessKeyId),
    secretStored: !!c.secretCiphertext,
    status: c.status,
    lastVerifiedAt: c.lastVerifiedAt,
    lastCheck: c.lastCheck,
    documentCount,
    prefix: customerPrefix(c.customerId),
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/**
 * Per-customer storage connector: lets a customer's documents live in a bucket
 * the customer controls (e.g. in their own AWS account).
 *   GET    /customers/:id/storage-connector          SA (full), TU assigned (summary)
 *   PUT    /customers/:id/storage-connector          SA - create or update
 *   POST   /customers/:id/storage-connector/verify   SA - live checks; ACTIVE only if all pass
 *   POST   /customers/:id/storage-connector/disable  SA - stop new uploads to it
 *   DELETE /customers/:id/storage-connector          SA - only when no documents use it
 *   GET    /storage-connectors/portal-identity       SA - principal for the customer's trust policy
 */
export function storageConnectorRoutes(s: Services): { customerScoped: Router; global: Router } {
  const customerScoped = Router({ mergeParams: true });
  const global = Router();
  const fetchImpl: FetchLike = (s.fetch ?? fetch) as FetchLike;

  const documentCount = (connectorId: string) =>
    s.prisma.document.count({ where: { storageConnectorId: connectorId, status: { not: "PURGED" } } });

  const setupFor = (c: { bucket: string; customerId: string; externalId: string; roleArn: string | null }, portalPrincipal?: string) => ({
    trustPolicy: portalPrincipal ? trustPolicy(portalPrincipal, c.externalId) : null,
    permissionsPolicy: permissionsPolicy(c.bucket, c.customerId, c.roleArn?.split(":")[1] ?? "aws"),
    corsConfiguration: corsConfiguration(new URL(s.config.appBaseUrl).origin),
  });

  const portalPrincipal = async (): Promise<{ arn?: string; error?: string }> => {
    try {
      return { arn: trustPrincipalFromCallerArn((await s.storageResolver.portalIdentity()).arn) };
    } catch {
      return { error: "The portal's AWS identity could not be determined. Configure CONNECTOR_AWS_ACCESS_KEY_ID / CONNECTOR_AWS_SECRET_ACCESS_KEY." };
    }
  };

  customerScoped.get("/", requireRoles(s, "SUPER_ADMIN", "TEKPRO_USER"), async (req, res) => {
    const { customerId } = customerParam.parse(req.params);
    const p = principal(req);
    await s.policy.requireCustomerAccess(p, customerId);
    const c = await s.prisma.storageConnector.findUnique({ where: { customerId } });
    if (!c) return res.json({ data: { mode: "PLATFORM", connector: null } });
    if (p.role !== "SUPER_ADMIN") {
      return res.json({ data: { mode: "CUSTOMER", connector: { provider: c.provider, bucket: c.bucket, region: c.region, status: c.status } } });
    }
    const identity = c.authType === "ASSUME_ROLE" ? await portalPrincipal() : {};
    res.json({
      data: {
        mode: "CUSTOMER",
        connector: serializeConnector(c, await documentCount(c.id)),
        portalPrincipalArn: identity.arn ?? null,
        portalIdentityError: identity.error ?? null,
        setup: setupFor(c, identity.arn),
      },
    });
  });

  customerScoped.put("/", requireRoles(s, "SUPER_ADMIN"), async (req, res) => {
    const { customerId } = customerParam.parse(req.params);
    const input = connectorInputSchema.parse(req.body);
    await s.policy.requireCustomerAccess(principal(req), customerId);
    const endpoint = input.endpoint ? validateEndpoint(input.endpoint, s.config.connectors.allowInsecureEndpoints) : null;
    if (input.authType === "ACCESS_KEY" && !s.config.connectors.encryptionKey) {
      throw badRequest("Access-key connectors require CONNECTOR_ENCRYPTION_KEY to be configured on the server");
    }

    const existing = await s.prisma.storageConnector.findUnique({ where: { customerId } });
    const next = { ...input, endpoint, forcePathStyle: input.provider === "S3_COMPATIBLE" ? input.forcePathStyle : false };
    if (existing) {
      const changed = LOCATION_FIELDS.filter((f) => (existing[f] ?? null) !== (next[f] ?? null));
      const docs = await documentCount(existing.id);
      if (changed.length && docs > 0) {
        throw conflict(
          `The bucket location cannot change while ${docs} document(s) are stored in it (changed: ${changed.join(", ")}). Credentials can still be updated.`,
          "CONFLICT",
          { documents: docs, changed },
        );
      }
    }

    const id = existing?.id ?? randomUUID();
    let accessKeyId: string | null = null;
    let secretCiphertext: string | null = null;
    if (input.authType === "ACCESS_KEY") {
      // When editing, an omitted key id keeps the stored one (the UI only ever sees it masked).
      const keepExisting = existing?.authType === "ACCESS_KEY" && !input.accessKeyId;
      accessKeyId = input.accessKeyId ?? (keepExisting ? existing!.accessKeyId : null);
      if (!accessKeyId) throw badRequest("The access key id is required");
      if (input.secretAccessKey) {
        secretCiphertext = encryptSecret(input.secretAccessKey, s.config.connectors.encryptionKey!, id);
      } else if (existing?.authType === "ACCESS_KEY" && existing.accessKeyId === accessKeyId && existing.secretCiphertext) {
        secretCiphertext = existing.secretCiphertext;
      } else {
        throw badRequest("The secret access key is required");
      }
    }

    const data = {
      provider: next.provider,
      bucket: next.bucket,
      region: next.region,
      endpoint: next.endpoint,
      forcePathStyle: next.forcePathStyle,
      authType: next.authType,
      roleArn: next.authType === "ASSUME_ROLE" ? next.roleArn! : null,
      accessKeyId,
      secretCiphertext,
      // Every change must be verified again before uploads resume.
      status: "PENDING_VERIFICATION" as const,
      lastCheck: Prisma.DbNull,
    };
    const saved = await s.prisma.$transaction(async (tx) => {
      const c = existing
        ? await tx.storageConnector.update({ where: { id }, data })
        : await tx.storageConnector.create({
            data: { ...data, id, customerId, externalId: `tekpro-${randomToken(18)}`, createdByUserId: principal(req).userId },
          });
      await s.audit.fromRequest(
        req,
        {
          action: existing ? AuditAction.STORAGE_CONNECTOR_UPDATED : AuditAction.STORAGE_CONNECTOR_CREATED,
          resourceType: "StorageConnector",
          resourceId: c.id,
          customerId,
          metadata: {
            provider: c.provider,
            bucket: c.bucket,
            region: c.region,
            endpoint: c.endpoint,
            authType: c.authType,
            roleArn: c.roleArn,
            accessKeyIdMasked: maskKeyId(c.accessKeyId),
            secretReplaced: !!input.secretAccessKey,
          },
        },
        tx,
      );
      return c;
    });
    s.storageResolver.invalidate(saved.id);
    res.status(existing ? 200 : 201).json({ data: serializeConnector(saved, await documentCount(saved.id)) });
  });

  customerScoped.post("/verify", requireRoles(s, "SUPER_ADMIN"), async (req, res) => {
    const { customerId } = customerParam.parse(req.params);
    await s.policy.requireCustomerAccess(principal(req), customerId);
    const c = await s.prisma.storageConnector.findUnique({ where: { customerId } });
    if (!c) throw notFound("Storage connector");
    s.storageResolver.invalidate(c.id);
    let result;
    try {
      result = await verifyStorage(s.storageResolver.forConnector(c), {
        customerId,
        appOrigin: new URL(s.config.appBaseUrl).origin,
        fetch: fetchImpl,
      });
    } catch (err) {
      result = { ok: false, checkedAt: new Date().toISOString(), checks: [{ id: "setup", label: "Connect to storage", ok: false, detail: (err as Error).message }] };
    }
    // A disabled connector stays disabled; otherwise the result decides.
    const status = c.status === "DISABLED" ? "DISABLED" : result.ok ? "ACTIVE" : "FAILED";
    const updated = await s.prisma.$transaction(async (tx) => {
      const u = await tx.storageConnector.update({
        where: { id: c.id },
        data: { status, lastCheck: result as unknown as Prisma.InputJsonObject, ...(result.ok ? { lastVerifiedAt: new Date() } : {}) },
      });
      await s.audit.fromRequest(
        req,
        {
          action: result.ok ? AuditAction.STORAGE_CONNECTOR_VERIFIED : AuditAction.STORAGE_CONNECTOR_VERIFICATION_FAILED,
          resourceType: "StorageConnector",
          resourceId: c.id,
          customerId,
          outcome: result.ok ? "SUCCESS" : "FAILURE",
          metadata: { failed: result.checks.filter((x) => !x.ok).map((x) => x.id) },
        },
        tx,
      );
      return u;
    });
    s.storageResolver.invalidate(c.id);
    res.json({ data: { result, connector: serializeConnector(updated, await documentCount(c.id)) } });
  });

  const setDisabled = (disabled: boolean) =>
    async (req: import("express").Request, res: import("express").Response) => {
      const { customerId } = customerParam.parse(req.params);
      await s.policy.requireCustomerAccess(principal(req), customerId);
      const c = await s.prisma.storageConnector.findUnique({ where: { customerId } });
      if (!c) throw notFound("Storage connector");
      const updated = await s.prisma.$transaction(async (tx) => {
        // Re-enabling requires a fresh verification before uploads resume.
        const u = await tx.storageConnector.update({ where: { id: c.id }, data: { status: disabled ? "DISABLED" : "PENDING_VERIFICATION" } });
        await s.audit.fromRequest(
          req,
          {
            action: disabled ? AuditAction.STORAGE_CONNECTOR_DISABLED : AuditAction.STORAGE_CONNECTOR_ENABLED,
            resourceType: "StorageConnector",
            resourceId: c.id,
            customerId,
          },
          tx,
        );
        return u;
      });
      s.storageResolver.invalidate(c.id);
      res.json({ data: serializeConnector(updated, await documentCount(c.id)) });
    };
  customerScoped.post("/disable", requireRoles(s, "SUPER_ADMIN"), setDisabled(true));
  customerScoped.post("/enable", requireRoles(s, "SUPER_ADMIN"), setDisabled(false));

  customerScoped.delete("/", requireRoles(s, "SUPER_ADMIN"), async (req, res) => {
    const { customerId } = customerParam.parse(req.params);
    await s.policy.requireCustomerAccess(principal(req), customerId);
    const c = await s.prisma.storageConnector.findUnique({ where: { customerId } });
    if (!c) throw notFound("Storage connector");
    const docs = await s.prisma.document.count({ where: { storageConnectorId: c.id } });
    if (docs > 0) {
      throw conflict(
        `${docs} document record(s) reference this storage. Delete (and let the retention period purge) those documents first, or disable the connector instead.`,
        "CONFLICT",
        { documents: docs },
      );
    }
    await s.prisma.$transaction(async (tx) => {
      await tx.storageConnector.delete({ where: { id: c.id } });
      await s.audit.fromRequest(
        req,
        { action: AuditAction.STORAGE_CONNECTOR_DELETED, resourceType: "StorageConnector", resourceId: c.id, customerId, metadata: { bucket: c.bucket } },
        tx,
      );
    });
    s.storageResolver.invalidate(c.id);
    res.status(204).end();
  });

  global.get("/portal-identity", requireRoles(s, "SUPER_ADMIN"), async (_req, res) => {
    const identity = await portalPrincipal();
    if (!identity.arn) throw new AppError(503, "STORAGE_UNAVAILABLE", identity.error!);
    res.json({ data: { principalArn: identity.arn } });
  });

  return { customerScoped, global };
}
