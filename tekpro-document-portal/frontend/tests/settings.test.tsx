import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OperationalSettings, SettingsPayload } from "../src/types/api";
import { makeUser, mockServer, renderApp } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const MB = 1024 ** 2;
const defaults: OperationalSettings = {
  uploadMaxFileSizeBytes: 5 * 1024 * MB,
  uploadMultipartThresholdBytes: 100 * MB,
  uploadPartSizeBytes: 64 * MB,
  uploadAllowedExtensions: ["docx", "pdf", "xlsx"],
  uploadUrlTtlSeconds: 900,
  uploadSessionTtlSeconds: 86400,
  downloadUrlTtlSeconds: 300,
  deletedDocumentRetentionDays: 30,
  sessionTtlSeconds: 43200,
  sessionIdleTimeoutSeconds: 1800,
};

function payload(values: Partial<OperationalSettings> = {}, overridden: (keyof OperationalSettings)[] = []): SettingsPayload {
  return {
    settings: {
      staffAuditAccess: true,
      staffCanDeleteDocuments: true,
      staffCanDeleteFolders: true,
      customerAdminActivityAccess: true,
      customerUserActivityAccess: false,
      customerAdminCanManageStorage: true,
    },
    operational: { values: { ...defaults, ...values }, defaults, overridden },
    environment: { storageDriver: "s3", mailDriver: "console", jobsEnabled: false },
  };
}

describe("Settings page", () => {
  it("uses plain-language names and shows limits in friendly units", async () => {
    const s = mockServer(makeUser("SUPER_ADMIN"));
    s.on("GET", /\/settings$/, () => payload());
    renderApp("/settings");
    expect(await screen.findByRole("heading", { name: "Who can do what" })).toBeInTheDocument();
    expect(screen.getByLabelText(/Customers can create and delete their storage bucket/)).toBeChecked();
    expect(screen.getByLabelText("Largest file allowed")).toHaveValue(5);
    expect(screen.getByLabelText("Download link valid for")).toHaveValue(5);
    expect(screen.getByLabelText("Keep deleted documents for")).toHaveValue(30);
    expect(screen.getByLabelText("Allowed file types")).toHaveValue("docx, pdf, xlsx");
    expect(screen.getByText("Printed in the server log (development only)")).toBeInTheDocument();
    expect(screen.queryByText("uploadMaxFileSizeBytes")).not.toBeInTheDocument();
  });

  it("saves only changed limits, converted to bytes and seconds", async () => {
    const s = mockServer(makeUser("SUPER_ADMIN"));
    s.on("GET", /\/settings$/, () => payload());
    s.on("PATCH", /\/settings\/operational$/, () => payload({ downloadUrlTtlSeconds: 120, uploadAllowedExtensions: ["csv", "pdf"] }, ["downloadUrlTtlSeconds", "uploadAllowedExtensions"]));
    renderApp("/settings");
    const ttl = await screen.findByLabelText("Download link valid for");
    await userEvent.clear(ttl);
    await userEvent.type(ttl, "2");
    const types = screen.getByLabelText("Allowed file types");
    await userEvent.clear(types);
    await userEvent.type(types, "pdf, .CSV");
    await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() =>
      expect(s.calls.find((c) => c.method === "PATCH")?.body).toEqual({ downloadUrlTtlSeconds: 120, uploadAllowedExtensions: ["csv", "pdf"] }),
    );
    expect(await screen.findByText("Saved")).toBeInTheDocument();
    expect(screen.getAllByText(/Changed from the default/).length).toBe(2);
  });

  it("resets a changed value to the server default", async () => {
    const s = mockServer(makeUser("SUPER_ADMIN"));
    s.on("GET", /\/settings$/, () => payload({ deletedDocumentRetentionDays: 7 }, ["deletedDocumentRetentionDays"]));
    s.on("PATCH", /\/settings\/operational$/, () => payload());
    renderApp("/settings");
    expect(await screen.findByLabelText("Keep deleted documents for")).toHaveValue(7);
    await userEvent.click(screen.getByRole("button", { name: "Reset to default" }));
    await waitFor(() => expect(s.calls.find((c) => c.method === "PATCH")?.body).toEqual({ deletedDocumentRetentionDays: null }));
    await waitFor(() => expect(screen.getByLabelText("Keep deleted documents for")).toHaveValue(30));
  });
});
