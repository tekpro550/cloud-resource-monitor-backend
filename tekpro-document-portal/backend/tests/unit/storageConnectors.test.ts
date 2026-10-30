import { describe, expect, it } from "vitest";
import { permissionsPolicy, trustPolicy, trustPrincipalFromCallerArn } from "../../src/modules/storageConnectors/policies.js";
import { decryptSecret, encryptSecret, maskKeyId } from "../../src/modules/storageConnectors/secrets.js";
import { browserOrigins, validateEndpoint } from "../../src/modules/storageConnectors/validation.js";

const key = Buffer.alloc(32, 9);

describe("connector secret encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encryptSecret("s3cret-value", key, "conn-1");
    const b = encryptSecret("s3cret-value", key, "conn-1");
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key, "conn-1")).toBe("s3cret-value");
  });

  it("is bound to the connector id and detects tampering or a wrong key", () => {
    const env = encryptSecret("s3cret-value", key, "conn-1");
    expect(() => decryptSecret(env, key, "conn-2")).toThrow();
    expect(() => decryptSecret(env, Buffer.alloc(32, 1), "conn-1")).toThrow();
    const parts = env.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), key, "conn-1")).toThrow();
  });

  it("masks access key ids", () => {
    expect(maskKeyId("AKIAIOSFODNN7EXAMPLE")).toBe("••••••••••••••••MPLE");
    expect(maskKeyId(null)).toBeNull();
  });
});

describe("custom endpoint validation", () => {
  it("accepts public https origins", () => {
    expect(validateEndpoint("https://s3.eu-central-1.wasabisys.com", false)).toBe("https://s3.eu-central-1.wasabisys.com");
  });
  it.each(["http://s3.example.com", "https://127.0.0.1", "https://192.168.1.10", "https://172.20.0.1", "https://100.64.0.1", "https://metadata.internal", "https://[fd00::1]", "https://s3.example.com/path"])(
    "rejects %s",
    (e) => expect(() => validateEndpoint(e, false)).toThrow(),
  );
  it("permits local endpoints only when explicitly allowed (development/testing)", () => {
    expect(validateEndpoint("http://localhost:5050", true)).toBe("http://localhost:5050");
  });
});

describe("IAM documents", () => {
  it("trust policy requires the External ID", () => {
    const t = trustPolicy("arn:aws:iam::111111111111:user/tekpro-portal", "tekpro-abc");
    expect(t.Statement[0]).toMatchObject({
      Principal: { AWS: "arn:aws:iam::111111111111:user/tekpro-portal" },
      Action: "sts:AssumeRole",
      Condition: { StringEquals: { "sts:ExternalId": "tekpro-abc" } },
    });
  });
  it("permissions are limited to the customer's prefix", () => {
    const p = permissionsPolicy("bucket-a", "cust-1");
    expect(p.Statement[0]!.Resource).toBe("arn:aws:s3:::bucket-a/customers/cust-1/*");
    expect(p.Statement[1]!.Condition).toEqual({ StringLike: { "s3:prefix": ["customers/cust-1/*"] } });
    expect(JSON.stringify(p)).not.toContain('"s3:*"');
  });
  it("derives the role principal from an assumed-role caller ARN", () => {
    expect(trustPrincipalFromCallerArn("arn:aws:sts::111111111111:assumed-role/PortalRole/i-123")).toBe("arn:aws:iam::111111111111:role/PortalRole");
    expect(trustPrincipalFromCallerArn("arn:aws:iam::111111111111:user/portal")).toBe("arn:aws:iam::111111111111:user/portal");
  });
  it("lists the browser origins of a bucket", () => {
    expect(browserOrigins({ provider: "AWS_S3", bucket: "b-1", region: "us-east-1", endpoint: null, forcePathStyle: false })).toEqual([
      "https://b-1.s3.us-east-1.amazonaws.com",
      "https://b-1.s3.amazonaws.com",
    ]);
    expect(browserOrigins({ provider: "S3_COMPATIBLE", bucket: "b-1", region: "eu-central-1", endpoint: "https://s3.example.com", forcePathStyle: true })).toEqual([
      "https://s3.example.com",
    ]);
  });
});
