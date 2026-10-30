import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StorageConnector } from "../src/types/api";
import { CUSTOMER_ID, makeUser, mockServer, renderApp } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const customer = { id: CUSTOMER_ID, name: "Antrix", customerCode: "ANTRIX", status: "ACTIVE", createdAt: "", updatedAt: "" };
const connector: StorageConnector = {
  id: "conn-1",
  customerId: CUSTOMER_ID,
  provider: "AWS_S3",
  bucket: "antrix-documents",
  region: "ap-south-1",
  endpoint: null,
  forcePathStyle: false,
  authType: "ASSUME_ROLE",
  roleArn: "arn:aws:iam::123456789012:role/TekproPortalAccess",
  externalId: "tekpro-ext-123",
  accessKeyIdMasked: null,
  secretStored: false,
  status: "PENDING_VERIFICATION",
  lastVerifiedAt: null,
  lastCheck: null,
  documentCount: 0,
  prefix: `customers/${CUSTOMER_ID}/`,
};

const GB = 1024 ** 3;
function usageFor(view: { mode: string; connector?: StorageConnector | null }, extra: object = {}) {
  const c = view.connector;
  return {
    usedBytes: 2 * GB,
    documents: { count: 12, bytes: 2 * GB },
    deletedPendingPurge: { count: 0, bytes: 0 },
    uploading: { count: 0, bytes: 0 },
    quotaBytes: null,
    availableBytes: null,
    location: c ? { mode: "CUSTOMER", provider: c.provider, bucket: c.bucket, region: c.region, status: c.status } : { mode: "PLATFORM" },
    bucketManagement: { allowed: true, available: !!c && c.provider !== "LIGHTSAIL", bucketPrefix: "tekpro-antrix-", documentsInBucket: 0 },
    ...extra,
  };
}

function server(view: { mode: string; connector?: StorageConnector | null } & Record<string, unknown>, usage: object = usageFor(view)) {
  const s = mockServer(makeUser("SUPER_ADMIN"));
  s.on("GET", /^\/api\/v1\/customers\/[^/]+$/, () => customer);
  s.on("GET", /\/stats$/, () => ({ folders: 0, activeUsers: 0, documentsByStatus: {}, last24h: { uploads: 0, bytes: 0 } }));
  s.on("GET", /\/storage-connector$/, () => view);
  s.on("GET", /\/storage-usage$/, () => usage);
  return s;
}

async function openStorageTab() {
  renderApp(`/customers/${CUSTOMER_ID}`);
  await userEvent.click(await screen.findByRole("tab", { name: "Storage" }));
}

describe("customer storage connector UI", () => {
  it("explains platform storage and submits a cross-account role connection", async () => {
    const s = server({ mode: "PLATFORM", connector: null });
    s.on("PUT", /\/storage-connector$/, () => connector);
    await openStorageTab();
    expect((await screen.findAllByText(/Tekpro platform storage/)).length).toBeGreaterThan(0);
    await userEvent.type(screen.getByLabelText("Bucket name"), "antrix-documents");
    await userEvent.type(screen.getByLabelText("Role ARN"), "arn:aws:iam::123456789012:role/TekproPortalAccess");
    await userEvent.click(screen.getByRole("button", { name: "Save connection" }));
    await waitFor(() => expect(s.calls.find((c) => c.method === "PUT")?.body).toEqual({
      provider: "AWS_S3",
      bucket: "antrix-documents",
      region: "ap-south-1",
      authType: "ASSUME_ROLE",
      roleArn: "arn:aws:iam::123456789012:role/TekproPortalAccess",
    }));
  });

  it("Lightsail buckets use an access key (no role option)", async () => {
    server({ mode: "PLATFORM", connector: null });
    await openStorageTab();
    await userEvent.selectOptions(await screen.findByLabelText("Storage type"), "LIGHTSAIL");
    expect(screen.queryByLabelText("How the portal connects")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Access key ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Secret access key")).toHaveAttribute("type", "password");
  });

  it("shows status, setup instructions with the External ID, and verification results", async () => {
    const s = server({
      mode: "CUSTOMER",
      connector,
      portalPrincipalArn: "arn:aws:iam::111111111111:user/tekpro-portal",
      setup: {
        trustPolicy: { Statement: [{ Condition: { StringEquals: { "sts:ExternalId": "tekpro-ext-123" } } }] },
        permissionsPolicy: {},
        bucketPrefix: "tekpro-antrix-",
        bucketManagementPolicy: { Statement: [{ Sid: "PortalManageBuckets" }] },
        corsConfiguration: {},
      },
    });
    s.on("POST", /\/storage-connector\/verify$/, () => ({
      result: { ok: false, checkedAt: new Date().toISOString(), checks: [{ id: "access", label: "Credentials can access the customer folder in the bucket", ok: false, detail: "AccessDenied" }] },
      connector: { ...connector, status: "FAILED" },
    }));
    await openStorageTab();
    expect((await screen.findAllByText("Needs verification")).length).toBeGreaterThan(0);
    expect(screen.getByText(/Uploads for this customer are paused/)).toBeInTheDocument();
    expect(screen.getAllByText("tekpro-ext-123").length).toBeGreaterThan(0);
    expect(screen.getByText("arn:aws:iam::111111111111:user/tekpro-portal")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Verify connection" }));
    expect(await screen.findByText("AccessDenied")).toBeInTheDocument();
    expect(screen.getByText(/Verification failed/)).toBeInTheDocument();
    expect(screen.getByText(/PortalManageBuckets/)).toBeInTheDocument();
  });
});

describe("storage space and buckets", () => {
  it("shows used, limit and available space and lets the Super Admin set a limit in GB", async () => {
    const s = server({ mode: "PLATFORM", connector: null });
    s.on("PATCH", /^\/api\/v1\/customers\/[^/]+$/, () => customer);
    await openStorageTab();
    expect(await screen.findByText("No limit")).toBeInTheDocument();
    expect(screen.getByText("Unlimited")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Set a limit" }));
    await userEvent.type(screen.getByLabelText("Storage limit (GB)"), "50");
    await userEvent.click(screen.getByRole("button", { name: "Save limit" }));
    await waitFor(() => expect(s.calls.find((c) => c.method === "PATCH")?.body).toEqual({ storageQuotaBytes: 50 * GB }));
  });

  it("shows a nearly full limit", async () => {
    server({ mode: "PLATFORM", connector: null }, usageFor({ mode: "PLATFORM" }, { quotaBytes: 2.1 * GB, availableBytes: 0.1 * GB }));
    await openStorageTab();
    expect(await screen.findByRole("progressbar", { name: "Storage used" })).toHaveAttribute("aria-valuenow", "95");
  });

  it("creates a bucket with the customer's prefix and reports the checks", async () => {
    const view = { mode: "CUSTOMER", connector: { ...connector, status: "ACTIVE" as const } };
    const s = server(view);
    s.on("POST", /\/storage-connector\/bucket$/, () => ({ result: { ok: true, checkedAt: "", checks: [] }, connector: { bucket: "tekpro-antrix-docs", region: "eu-west-1", status: "ACTIVE" } }));
    await openStorageTab();
    await userEvent.click(await screen.findByRole("button", { name: "Create new bucket" }));
    expect(screen.getByText("tekpro-antrix-")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Bucket name"), "Docs");
    await userEvent.clear(screen.getByLabelText("AWS region"));
    await userEvent.type(screen.getByLabelText("AWS region"), "eu-west-1");
    await userEvent.click(screen.getByRole("button", { name: "Create bucket" }));
    await waitFor(() => expect(s.calls.find((c) => c.method === "POST" && c.path.endsWith("/bucket"))?.body).toEqual({ bucket: "tekpro-antrix-docs", region: "eu-west-1" }));
    expect(await screen.findByText(/all checks passed/)).toBeInTheDocument();
  });

  it("deleting a bucket requires typing its name", async () => {
    const s = server({ mode: "CUSTOMER", connector: { ...connector, status: "ACTIVE" } });
    s.on("DELETE", /\/storage-connector\/bucket$/, () => ({ deleted: "antrix-documents", storage: "PLATFORM" }));
    await openStorageTab();
    await userEvent.click(await screen.findByRole("button", { name: "Delete bucket" }));
    const confirm = screen.getAllByRole("button", { name: "Delete bucket" }).at(-1)!;
    expect(confirm).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Type antrix-documents to confirm"), "antrix-documents");
    await userEvent.click(confirm);
    await waitFor(() => expect(s.calls.find((c) => c.method === "DELETE")?.body).toEqual({ confirmBucket: "antrix-documents" }));
  });

  it("buckets holding documents cannot be replaced or deleted", async () => {
    const view = { mode: "CUSTOMER", connector: { ...connector, status: "ACTIVE" as const } };
    server(view, usageFor(view, { bucketManagement: { allowed: true, available: true, bucketPrefix: "tekpro-antrix-", documentsInBucket: 3 } }));
    await openStorageTab();
    expect(await screen.findByRole("button", { name: "Create new bucket" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete bucket" })).toBeDisabled();
  });

  it("Customer Admins see their organisation's storage and can manage the bucket when allowed", async () => {
    const s = mockServer({ ...makeUser("CUSTOMER_ADMIN"), customerId: CUSTOMER_ID });
    s.on("GET", /\/storage-usage$/, () => usageFor({ mode: "CUSTOMER", connector: { ...connector, status: "ACTIVE" } }, { quotaBytes: 10 * GB, availableBytes: 8 * GB }));
    renderApp("/organisation-storage");
    expect(await screen.findByRole("heading", { name: "Storage" })).toBeInTheDocument();
    expect(screen.getByText("8.0 GB")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /limit/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create new bucket" })).toBeInTheDocument();
  });

  it("Customer Admins get no bucket actions when the setting is off", async () => {
    const s = mockServer({ ...makeUser("CUSTOMER_ADMIN"), customerId: CUSTOMER_ID });
    s.on("GET", /\/storage-usage$/, () =>
      usageFor({ mode: "CUSTOMER", connector }, { bucketManagement: { allowed: false, available: true, bucketPrefix: "tekpro-antrix-", documentsInBucket: 0 } }),
    );
    renderApp("/organisation-storage");
    expect(await screen.findByText("antrix-documents")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create new bucket" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Delete bucket" })).not.toBeInTheDocument();
  });
});

describe("Storage page (Super Admin)", () => {
  const stats = (storageConnector: object | null) => ({
    customers: [{ ...customer, byStatus: { AVAILABLE: { count: 2, bytes: 3 * GB } }, storageQuotaBytes: 10 * GB, storageConnector }],
    dailyUploads: [],
  });

  it("shows where each customer's documents are stored and links to the connection setup", async () => {
    const s = server({ mode: "PLATFORM", connector: null });
    s.on("GET", /\/stats\/storage$/, () => stats(null));
    s.on("GET", /\/storage-usage$/, () => usageFor({ mode: "PLATFORM" }));
    renderApp("/storage");
    expect(await screen.findByRole("heading", { name: "Document storage by customer" })).toBeInTheDocument();
    expect(screen.getAllByText("Tekpro platform storage").length).toBeGreaterThan(0);
    expect(screen.getByText(/3\.0 GB \/ 10 GB/)).toBeInTheDocument();
    expect(screen.getByText("7.0 GB available")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("link", { name: "Connect customer storage" }));
    expect(await screen.findByRole("tab", { name: "Storage", selected: true })).toBeInTheDocument();
  });

  it("shows a connected customer bucket with its status", async () => {
    const s = server({ mode: "CUSTOMER", connector });
    s.on("GET", /\/stats\/storage$/, () => stats({ provider: "AWS_S3", bucket: "antrix-documents", region: "ap-south-1", authType: "ASSUME_ROLE", status: "ACTIVE", lastVerifiedAt: null }));
    renderApp("/storage");
    expect(await screen.findByText(/antrix-documents · ap-south-1 · IAM role/)).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage" })).toHaveAttribute("href", `/customers/${CUSTOMER_ID}?tab=storage`);
  });

  it("is not available to other roles", async () => {
    mockServer(makeUser("TEKPRO_USER"));
    renderApp("/storage");
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Document storage by customer" })).not.toBeInTheDocument());
  });
});
