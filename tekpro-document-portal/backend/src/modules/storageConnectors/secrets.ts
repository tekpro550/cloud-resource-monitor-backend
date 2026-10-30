import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for customer storage secrets (ACCESS_KEY connectors).
 * Format: v1.<iv>.<tag>.<ciphertext>, each part base64url. The connector id is
 * bound as additional authenticated data, so a ciphertext cannot be copied to
 * another connector row.
 */
export function encryptSecret(plaintext: string, key: Buffer, connectorId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(connectorId));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(envelope: string, key: Buffer, connectorId: string): string {
  const [version, iv, tag, ct] = envelope.split(".");
  if (version !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(connectorId));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

/** Shows only the last four characters of an access key id. */
export function maskKeyId(id: string | null): string | null {
  return id ? `${"•".repeat(Math.max(0, id.length - 4))}${id.slice(-4)}` : null;
}
