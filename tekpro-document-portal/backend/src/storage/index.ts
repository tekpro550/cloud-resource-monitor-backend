import type { AppConfig } from "../config/env.js";
import { MemoryStorageAdapter } from "./memoryStorage.js";
import { S3StorageAdapter } from "./s3Storage.js";
import type { StorageAdapter } from "./storage.js";

export function createStorage(config: AppConfig): StorageAdapter {
  if (config.storage.driver === "memory") {
    if (config.isProduction) throw new Error("The memory storage driver cannot be used in production");
    return new MemoryStorageAdapter();
  }
  return new S3StorageAdapter(config.storage);
}

/** Origin the browser talks to for pre-signed requests (used for the CSP connect-src). */
export function storageBrowserOrigin(config: AppConfig): string | undefined {
  const s = config.storage;
  if (s.publicOrigin) return new URL(s.publicOrigin).origin;
  if (s.driver !== "s3") return undefined;
  if (s.endpoint) {
    const u = new URL(s.endpoint);
    return s.forcePathStyle ? u.origin : `${u.protocol}//${s.bucket}.${u.host}`;
  }
  return `https://${s.bucket}.s3.${s.region}.amazonaws.com`;
}

export * from "./storage.js";
