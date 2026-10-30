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

function server(view: object) {
  const s = mockServer(makeUser("SUPER_ADMIN"));
  s.on("GET", /^\/api\/v1\/customers\/[^/]+$/, () => customer);
  s.on("GET", /\/stats$/, () => ({ folders: 0, activeUsers: 0, documentsByStatus: {}, last24h: { uploads: 0, bytes: 0 } }));
  s.on("GET", /\/storage-connector$/, () => view);
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
    expect(await screen.findByText(/Tekpro platform storage/)).toBeInTheDocument();
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
      setup: { trustPolicy: { Statement: [{ Condition: { StringEquals: { "sts:ExternalId": "tekpro-ext-123" } } }] }, permissionsPolicy: {}, corsConfiguration: {} },
    });
    s.on("POST", /\/storage-connector\/verify$/, () => ({
      result: { ok: false, checkedAt: new Date().toISOString(), checks: [{ id: "access", label: "Credentials can access the customer folder in the bucket", ok: false, detail: "AccessDenied" }] },
      connector: { ...connector, status: "FAILED" },
    }));
    await openStorageTab();
    expect(await screen.findByText("Needs verification")).toBeInTheDocument();
    expect(screen.getByText(/Uploads for this customer are paused/)).toBeInTheDocument();
    expect(screen.getAllByText("tekpro-ext-123").length).toBeGreaterThan(0);
    expect(screen.getByText("arn:aws:iam::111111111111:user/tekpro-portal")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Verify connection" }));
    expect(await screen.findByText("AccessDenied")).toBeInTheDocument();
    expect(screen.getByText(/Verification failed/)).toBeInTheDocument();
  });
});

describe("Storage page (Super Admin)", () => {
  const stats = (storageConnector: object | null) => ({
    customers: [{ ...customer, byStatus: {}, storageConnector }],
    dailyUploads: [],
  });

  it("shows where each customer's documents are stored and links to the connection setup", async () => {
    const s = server({ mode: "PLATFORM", connector: null });
    s.on("GET", /\/stats\/storage$/, () => stats(null));
    renderApp("/storage");
    expect(await screen.findByRole("heading", { name: "Document storage by customer" })).toBeInTheDocument();
    expect(screen.getAllByText("Tekpro platform storage").length).toBeGreaterThan(0);
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
