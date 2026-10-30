import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/env.js";
import { sanitizeMetadata } from "../../src/modules/audit/audit.service.js";
import { validatePasswordStrength } from "../../src/modules/auth/password.js";
import { checkContent } from "../../src/modules/uploads/fileTypes.js";
import { mapS3Error } from "../../src/storage/s3Storage.js";
import { storageBrowserOrigin } from "../../src/storage/index.js";
import { attachmentContentDisposition, fileExtension, validateDisplayName } from "../../src/utils/filenames.js";

const allowed = new Set(["pdf", "docx", "xlsx", "txt", "csv", "png", "zip", "doc"]);
const bytes = (...b: number[]) => {
  const out = new Uint8Array(512);
  out.set(b);
  return out;
};

describe("display name validation", () => {
  it("accepts normal names and normalises whitespace", () => {
    expect(validateDisplayName("  Q1 Report (final).pdf ", "File name")).toBe("Q1 Report (final).pdf");
    expect(validateDisplayName("Résumé – 2024.docx", "File name")).toBe("Résumé – 2024.docx");
  });

  it.each(["../x.pdf", "a/b.pdf", "a\\b.pdf", "x\u0000.pdf", "..", ".", "NUL.txt", "trailing.", "evil‮fdp.exe", "a<b>.pdf", ""])(
    "rejects %j",
    (name) => {
      expect(() => validateDisplayName(name, "File name")).toThrow();
    },
  );

  it("extracts lower-case extensions", () => {
    expect(fileExtension("A.PDF")).toBe("pdf");
    expect(fileExtension(".bashrc")).toBe("");
    expect(fileExtension("noext")).toBe("");
  });

  it("builds a safe attachment Content-Disposition", () => {
    const v = attachmentContentDisposition('Ré"port.pdf');
    expect(v).toMatch(/^attachment; filename="R__port\.pdf"; filename\*=UTF-8''R%C3%A9%22port\.pdf$/);
  });
});

describe("content signature checks", () => {
  it("accepts matching signatures", async () => {
    expect((await checkContent(new TextEncoder().encode("%PDF-1.7\n..."), "pdf", allowed)).ok).toBe(true);
    expect((await checkContent(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52), "png", allowed)).ok).toBe(true);
    expect((await checkContent(bytes(0x50, 0x4b, 0x03, 0x04), "docx", allowed)).ok).toBe(true);
    expect((await checkContent(new TextEncoder().encode("a,b\n1,2"), "csv", allowed)).ok).toBe(true);
  });

  it("rejects mismatches and executables", async () => {
    const exe = await checkContent(bytes(0x4d, 0x5a), "pdf", allowed);
    expect(exe.ok).toBe(false);
    expect(exe.reason).toContain("exe");
    expect((await checkContent(bytes(0x7f, 0x45, 0x4c, 0x46), "txt", allowed)).ok).toBe(false);
    expect((await checkContent(new TextEncoder().encode("just text"), "pdf", allowed)).ok).toBe(false);
  });
});

describe("password policy", () => {
  it("enforces length, variety and email reuse", () => {
    expect(() => validatePasswordStrength("short1A!", 12)).toThrow();
    expect(() => validatePasswordStrength("aaaaaaaaaaaaaaaa", 12)).toThrow();
    expect(() => validatePasswordStrength("alllowercaseletters", 12)).toThrow();
    expect(() => validatePasswordStrength("JohnSmith-2024-x", 12, "johnsmith@antrix.test")).toThrow();
    expect(() => validatePasswordStrength("Correct-Horse-Battery-9", 12, "user@antrix.test")).not.toThrow();
  });
});

describe("audit metadata sanitisation", () => {
  it("redacts credential-like keys at any depth", () => {
    expect(
      sanitizeMetadata({ password: "x", nested: { token: "t", downloadUrl: "https://..." }, list: [{ secretAccessKey: "k" }], ok: 1, big: 5n }),
    ).toEqual({ password: "[REDACTED]", nested: { token: "[REDACTED]", downloadUrl: "[REDACTED]" }, list: [{ secretAccessKey: "[REDACTED]" }], ok: 1, big: 5 });
  });
});

describe("configuration validation", () => {
  const base = {
    DATABASE_URL: "postgresql://x",
    SESSION_SECRET: "k".repeat(40),
    APP_BASE_URL: "https://portal.tekpro.example",
    STORAGE_REGION: "ap-south-1",
    STORAGE_BUCKET: "tekpro-docs",
    STORAGE_ACCESS_KEY_ID: "AKIA...",
    STORAGE_SECRET_ACCESS_KEY: "s",
  };

  it("accepts a complete production configuration", () => {
    const c = loadConfig({ ...base, NODE_ENV: "production" });
    expect(c.session.cookieName).toBe("__Host-tdp_session");
    expect(c.downloadUrlTtlSeconds).toBe(300);
    expect(c.corsAllowedOrigins).toEqual(["https://portal.tekpro.example"]);
  });

  it("fails safely when production configuration is unsafe or incomplete", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: "production", STORAGE_DRIVER: "memory" })).toThrow(/STORAGE_DRIVER/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", APP_BASE_URL: "http://portal" })).toThrow(/https/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", SESSION_SECRET: "change-me-change-me-change-me-change-me" })).toThrow(/placeholder/);
    expect(() => loadConfig({ ...base, SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, STORAGE_BUCKET: undefined })).toThrow(/STORAGE_BUCKET/);
    expect(() => loadConfig({ ...base, NODE_ENV: "production", MAIL_DRIVER: "console" })).toThrow(/MAIL_DRIVER/);
  });

  it("derives the browser storage origin used by the CSP", () => {
    expect(storageBrowserOrigin(loadConfig(base))).toBe("https://tekpro-docs.s3.ap-south-1.amazonaws.com");
    expect(storageBrowserOrigin(loadConfig({ ...base, STORAGE_ENDPOINT: "http://localhost:9000", STORAGE_FORCE_PATH_STYLE: "true" }))).toBe(
      "http://localhost:9000",
    );
  });
});

describe("storage error mapping", () => {
  it("maps provider errors to safe, typed errors", () => {
    expect(mapS3Error("HeadObject", { name: "NotFound", $metadata: { httpStatusCode: 404 } }).kind).toBe("NOT_FOUND");
    expect(mapS3Error("Put", { name: "AccessDenied", $metadata: { httpStatusCode: 403 } }).kind).toBe("ACCESS_DENIED");
    expect(mapS3Error("Put", { name: "SignatureDoesNotMatch", $metadata: { httpStatusCode: 403 } }).kind).toBe("INVALID_SIGNATURE");
    expect(mapS3Error("Put", { name: "SignatureDoesNotMatch" }).kind).toBe("INVALID_SIGNATURE");
    expect(mapS3Error("Complete", { name: "InvalidPart", $metadata: { httpStatusCode: 400 } }).kind).toBe("INCOMPLETE_UPLOAD");
    const timeout = mapS3Error("Get", { name: "TimeoutError" });
    expect(timeout.kind).toBe("TIMEOUT");
    expect(timeout.retryable).toBe(true);
    const unavailable = mapS3Error("Get", { name: "ServiceUnavailable", $metadata: { httpStatusCode: 503 }, message: "secret detail AKIA123" });
    expect(unavailable.kind).toBe("UNAVAILABLE");
    expect(unavailable.message).not.toContain("AKIA123");
  });
});

describe("configuration from .env.example", () => {
  it("treats empty values as unset", () => {
    const c = loadConfig({
      DATABASE_URL: "postgresql://x",
      SESSION_SECRET: "k".repeat(40),
      APP_BASE_URL: "http://localhost:5173",
      STORAGE_ENDPOINT: "",
      STORAGE_PUBLIC_ORIGIN: "",
      SERVE_FRONTEND_DIR: "",
      STORAGE_REGION: "ap-south-1",
      STORAGE_BUCKET: "b",
      STORAGE_ACCESS_KEY_ID: "a",
      STORAGE_SECRET_ACCESS_KEY: "s",
    });
    expect(c.storage.endpoint).toBeUndefined();
    expect(c.serveFrontendDir).toBeUndefined();
  });
});
