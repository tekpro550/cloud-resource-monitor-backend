/**
 * Customer storage connector against a real S3/STS-compatible endpoint, using the
 * production code path (StorageResolver -> STS AssumeRole -> S3 client) and real
 * HTTP for the verification checks. Runs with STORAGE_IT_* plus
 * STORAGE_IT_STS_ENDPOINT (emulators) or CONNECTOR_IT_ROLE_ARN (real AWS).
 */
import { CreateBucketCommand, PutBucketCorsCommand, S3Client } from "@aws-sdk/client-s3";
import { pino } from "pino";
import { beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { RecordingMailer } from "../../src/modules/mail/mailer.js";
import { MemoryStorageAdapter } from "../../src/storage/memoryStorage.js";
import { api, createFolder, createUser, login, prisma, resetDb, testConfig } from "../helpers/testApp.js";

const env = process.env;
const configured = !!(env.STORAGE_IT_BUCKET && env.STORAGE_IT_ACCESS_KEY_ID && env.STORAGE_IT_SECRET_ACCESS_KEY && env.STORAGE_IT_REGION && (env.STORAGE_IT_STS_ENDPOINT || env.CONNECTOR_IT_ROLE_ARN));
const strict = env.STORAGE_IT_STRICT === "true";
const APP = "http://portal.test";

describe.skipIf(!configured)("customer storage connector (cross-account role) against real endpoints", () => {
  const bucket = `${env.STORAGE_IT_BUCKET}-connector`.slice(0, 63);

  beforeAll(async () => {
    if (env.STORAGE_IT_CREATE_BUCKET === "true") {
      const c = new S3Client({
        region: env.STORAGE_IT_REGION,
        endpoint: env.STORAGE_IT_ENDPOINT,
        forcePathStyle: env.STORAGE_IT_FORCE_PATH_STYLE === "true",
        credentials: { accessKeyId: env.STORAGE_IT_ACCESS_KEY_ID!, secretAccessKey: env.STORAGE_IT_SECRET_ACCESS_KEY! },
      });
      await c.send(new CreateBucketCommand({ Bucket: bucket })).catch(() => undefined);
      await c.send(
        new PutBucketCorsCommand({
          Bucket: bucket,
          CORSConfiguration: { CORSRules: [{ AllowedOrigins: [APP], AllowedMethods: ["PUT", "GET", "HEAD"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag"] }] },
        }),
      );
    }
  });

  it("assumes the customer role, verifies the bucket and serves uploads/downloads from it", async () => {
    await resetDb();
    const config = testConfig({
      APP_BASE_URL: APP,
      CONNECTOR_AWS_ACCESS_KEY_ID: env.STORAGE_IT_ACCESS_KEY_ID!,
      CONNECTOR_AWS_SECRET_ACCESS_KEY: env.STORAGE_IT_SECRET_ACCESS_KEY!,
      CONNECTOR_STS_REGION: env.STORAGE_IT_REGION!,
      ...(env.STORAGE_IT_STS_ENDPOINT ? { CONNECTOR_STS_ENDPOINT: env.STORAGE_IT_STS_ENDPOINT, CONNECTOR_ALLOW_INSECURE_ENDPOINTS: "true" } : {}),
    });
    const { app } = createApp({ config, prisma: prisma(), storage: new MemoryStorageAdapter(), mailer: new RecordingMailer(), logger: pino({ level: "silent" }) });
    const customer = await prisma().customer.create({ data: { name: "Conn", customerCode: "CONN" } });
    const folder = await createFolder(customer.id, "Inbox");
    await createUser({ email: "sa@conn.test", role: "SUPER_ADMIN" });
    await createUser({ email: "admin@conn.test", role: "CUSTOMER_ADMIN", customerId: customer.id });
    const sa = await login(app, "sa@conn.test");

    const identity = await api(sa).get("/api/v1/storage-connectors/portal-identity");
    expect(identity.status).toBe(200);
    expect(identity.body.data.principalArn).toMatch(/^arn:aws/);

    const url = `/api/v1/customers/${customer.id}/storage-connector`;
    const put = await api(sa).put(url, {
      ...(env.STORAGE_IT_ENDPOINT
        ? { provider: "S3_COMPATIBLE", endpoint: env.STORAGE_IT_ENDPOINT, forcePathStyle: env.STORAGE_IT_FORCE_PATH_STYLE === "true" }
        : { provider: "AWS_S3" }),
      bucket,
      region: env.STORAGE_IT_REGION,
      authType: "ASSUME_ROLE",
      roleArn: env.CONNECTOR_IT_ROLE_ARN ?? "arn:aws:iam::123456789012:role/TekproPortalAccess",
    });
    expect(put.status).toBe(201);
    const full = await api(sa).get(url);
    expect(full.body.data.setup.trustPolicy.Statement[0].Condition.StringEquals["sts:ExternalId"]).toBe(put.body.data.externalId);

    const verify = await api(sa).post(`${url}/verify`);
    const checks = verify.body.data.result.checks as { id: string; ok: boolean; detail?: string }[];
    const failed = checks.filter((c) => !c.ok && (strict || c.id !== "private"));
    expect(failed).toEqual([]);
    if (strict) expect(verify.body.data.connector.status).toBe("ACTIVE");
    else await prisma().storageConnector.update({ where: { customerId: customer.id }, data: { status: "ACTIVE" } });

    const body = "%PDF-1.7\n% connector e2e\n%%EOF";
    const init = await api(sa).post(`/api/v1/customers/${customer.id}/uploads/initiate`, { folderId: folder.id, filename: "Conn.pdf", sizeBytes: body.length });
    expect(init.status).toBe(201);
    expect(init.body.data.upload.url).toContain(bucket);
    expect(init.body.data.upload.url).toContain("X-Amz-Security-Token");
    const res = await fetch(init.body.data.upload.url, { method: "PUT", headers: init.body.data.upload.headers, body });
    expect(res.status).toBe(200);
    const done = await api(sa).post(`/api/v1/uploads/${init.body.data.uploadId}/complete`);
    expect(done.status).toBe(200);

    const admin = await login(app, "admin@conn.test");
    const dl = await api(admin).get(`/api/v1/documents/${done.body.data.id}/download`);
    expect(await (await fetch(dl.body.data.url)).text()).toBe(body);
  });
});
