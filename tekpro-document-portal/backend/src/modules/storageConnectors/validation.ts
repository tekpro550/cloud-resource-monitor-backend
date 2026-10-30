import { isIP } from "node:net";
import { z } from "zod";
import { badRequest } from "../../utils/errors.js";

/** S3 bucket naming rules; dots are rejected because they break TLS on virtual-hosted URLs. */
export const BUCKET_RE = /^(?!xn--)(?!sthree-)(?!.*-s3alias$)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
export const REGION_RE = /^[a-z]{2}(-gov)?-[a-z]+-\d$/;
export const ROLE_ARN_RE = /^arn:aws(-cn|-us-gov)?:iam::\d{12}:role\/[\w+=,.@/-]{1,512}$/;
export const ACCESS_KEY_ID_RE = /^[A-Z0-9]{16,128}$/;

export const connectorInputSchema = z
  .object({
    provider: z.enum(["AWS_S3", "LIGHTSAIL", "S3_COMPATIBLE"]),
    bucket: z.string().trim().regex(BUCKET_RE, "Bucket name must be 3-63 lower-case letters, digits or hyphens"),
    region: z.string().trim().regex(REGION_RE, "Region must look like ap-south-1"),
    endpoint: z.string().trim().url().nullish(),
    forcePathStyle: z.boolean().default(false),
    authType: z.enum(["ASSUME_ROLE", "ACCESS_KEY"]),
    roleArn: z.string().trim().regex(ROLE_ARN_RE, "Role ARN must look like arn:aws:iam::123456789012:role/Name").nullish(),
    accessKeyId: z.string().trim().regex(ACCESS_KEY_ID_RE, "Access key id is not valid").nullish(),
    secretAccessKey: z.string().min(16).max(256).nullish(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.authType === "ASSUME_ROLE" && !v.roleArn) ctx.addIssue({ code: "custom", path: ["roleArn"], message: "Role ARN is required" });
    if (v.provider === "S3_COMPATIBLE" && !v.endpoint) ctx.addIssue({ code: "custom", path: ["endpoint"], message: "Endpoint is required for S3-compatible storage" });
    if (v.provider !== "S3_COMPATIBLE" && v.endpoint) ctx.addIssue({ code: "custom", path: ["endpoint"], message: "Endpoint is only used for S3-compatible storage" });
    if (v.provider === "LIGHTSAIL" && v.authType === "ASSUME_ROLE") {
      ctx.addIssue({ code: "custom", path: ["authType"], message: "Lightsail buckets cannot grant write access to another account; use a bucket access key" });
    }
  });

export type ConnectorInput = z.infer<typeof connectorInputSchema>;

function isPrivateAddress(host: string): boolean {
  const v = isIP(host);
  if (v === 4) {
    const [a, b] = host.split(".").map(Number) as [number, number];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (v === 6) {
    const h = host.toLowerCase();
    return h === "::1" || h === "::" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:");
  }
  return false;
}

/**
 * The portal server sends requests to a custom endpoint, so it must not be
 * usable to reach internal services (SSRF): HTTPS only, no credentials in the
 * URL, no localhost or private/link-local address literals. Hostnames that
 * resolve to private addresses are a documented residual risk (Super Admin only).
 */
export function validateEndpoint(raw: string, allowInsecure: boolean): string {
  const u = new URL(raw);
  if (u.username || u.password) throw badRequest("Endpoint must not contain credentials");
  if (u.pathname !== "/" || u.search || u.hash) throw badRequest("Endpoint must be a bare origin, e.g. https://storage.example.com");
  if (!allowInsecure) {
    if (u.protocol !== "https:") throw badRequest("Endpoint must use https://");
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || isPrivateAddress(host)) {
      throw badRequest("Endpoint must be a public address");
    }
  } else if (!["https:", "http:"].includes(u.protocol)) {
    throw badRequest("Endpoint must use http(s)://");
  }
  return u.origin;
}

/** Origins the browser contacts for pre-signed requests to this bucket (for the CSP). */
export function browserOrigins(c: { provider: string; bucket: string; region: string; endpoint: string | null; forcePathStyle: boolean }): string[] {
  if (c.endpoint) {
    const u = new URL(c.endpoint);
    return [c.forcePathStyle ? u.origin : `${u.protocol}//${c.bucket}.${u.host}`];
  }
  const origins = [`https://${c.bucket}.s3.${c.region}.amazonaws.com`];
  if (c.region === "us-east-1") origins.push(`https://${c.bucket}.s3.amazonaws.com`);
  return origins;
}
