import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { navItemsFor } from "../src/layouts/AppLayout";
import type { DocumentItem, Folder } from "../src/types/api";
import { CUSTOMER_ID, HttpError, makeUser, mockServer, paged, renderApp } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const folders: Folder[] = [
  { id: "f-reports", customerId: CUSTOMER_ID, parentFolderId: null, name: "Reports", access: "DOWNLOAD", documentCount: 1, createdAt: "", updatedAt: "" },
  { id: "f-2024", customerId: CUSTOMER_ID, parentFolderId: "f-reports", name: "2024", access: "DOWNLOAD", documentCount: 0, createdAt: "", updatedAt: "" },
];
const doc: DocumentItem = {
  id: "d-1",
  customerId: CUSTOMER_ID,
  folderId: "f-reports",
  folderName: "Reports",
  displayName: "Annual Report.pdf",
  extension: "pdf",
  mimeType: "application/pdf",
  sizeBytes: 2_621_440,
  description: null,
  status: "AVAILABLE",
  createdAt: "2024-03-01T10:00:00Z",
  updatedAt: "2024-03-01T10:00:00Z",
  availableAt: "2024-03-01T10:00:00Z",
  canDownload: true,
};

function explorerServer(role: Parameters<typeof makeUser>[0], docs: DocumentItem[] = [doc]) {
  const user = makeUser(role);
  const server = mockServer(user);
  server.on("GET", /^\/api\/v1\/customers\/[^/]+$/, () => ({ id: CUSTOMER_ID, name: "Antrix", customerCode: "ANTRIX", status: "ACTIVE", createdAt: "", updatedAt: "" }));
  server.on("GET", /\/folders$/, () => folders.map((f) => ({ ...f, access: role.startsWith("CUSTOMER") ? "DOWNLOAD" : "MANAGE" })));
  server.on("GET", /\/documents$/, () => paged(docs));
  return server;
}

describe("role-specific navigation", () => {
  it("builds the expected menu for every role", () => {
    const labels = (role: Parameters<typeof navItemsFor>[0], a = false) => navItemsFor(role, a).map((i) => i.label);
    expect(labels("SUPER_ADMIN")).toEqual(["Dashboard", "Customers", "Users", "Audit logs", "Storage", "Settings", "My account"]);
    expect(labels("TEKPRO_USER")).toEqual(["Dashboard", "My customers", "My account"]);
    expect(labels("TEKPRO_USER", true)).toContain("Activity");
    expect(labels("CUSTOMER_ADMIN")).toEqual(["Dashboard", "Documents", "Storage", "My account"]);
    expect(labels("CUSTOMER_USER", true)).toEqual(["Dashboard", "Documents", "Activity", "My account"]);
  });

  it("shows customer users no administrative navigation", async () => {
    explorerServer("CUSTOMER_USER");
    renderApp("/documents");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(within(nav).queryByText("Users")).not.toBeInTheDocument();
    expect(within(nav).queryByText("Customers")).not.toBeInTheDocument();
    expect(within(nav).queryByText("Settings")).not.toBeInTheDocument();
  });

  it("blocks customer users from admin routes in the UI", async () => {
    mockServer(makeUser("CUSTOMER_ADMIN"));
    renderApp("/users");
    expect(await screen.findByText("Access denied")).toBeInTheDocument();
  });

  it("redirects anonymous visitors to the login page", async () => {
    mockServer(null);
    renderApp("/customers");
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });
});

describe("document explorer", () => {
  it("customer users see download but no upload, edit, move, delete or folder controls", async () => {
    explorerServer("CUSTOMER_USER");
    renderApp("/documents");
    expect(await screen.findByText("Annual Report.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Download Annual Report.pdf" })).toBeInTheDocument();
    for (const name of [/rename/i, /^move/i, /delete/i, /choose files/i, /\+ folder/i, /new subfolder/i, /customer access/i]) {
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    }
    expect(screen.queryByLabelText("Upload documents")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Document status")).not.toBeInTheDocument();
  });

  it("customer admins are also download-only", async () => {
    explorerServer("CUSTOMER_ADMIN");
    renderApp("/documents?folder=f-reports");
    expect(await screen.findByText("Annual Report.pdf")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /choose files/i })).not.toBeInTheDocument();
  });

  it("Tekpro users see upload controls and document actions", async () => {
    explorerServer("TEKPRO_USER");
    renderApp(`/customers/${CUSTOMER_ID}/documents?folder=f-reports`);
    expect(await screen.findByText("Annual Report.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rename Annual Report.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete Annual Report.pdf" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Choose files" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New subfolder" })).toBeInTheDocument();
    // Folder visibility is a Super Admin control.
    expect(screen.queryByRole("button", { name: "Customer access" })).not.toBeInTheDocument();
  });

  it("downloads through the authorised API and reports the status without loading the file", async () => {
    const server = explorerServer("CUSTOMER_USER");
    server.on("GET", /\/documents\/d-1\/download$/, () => ({ url: "https://bucket.example/obj?X-Amz-Signature=abc", expiresAt: "", filename: doc.displayName, sizeBytes: doc.sizeBytes }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderApp("/documents");
    await userEvent.click(await screen.findByRole("button", { name: "Download Annual Report.pdf" }));
    expect(await screen.findByText("Download started")).toBeInTheDocument();
    expect(click).toHaveBeenCalledTimes(1);
    expect(server.calls.some((c) => c.path === "/api/v1/documents/d-1/download")).toBe(true);
  });

  it("shows a friendly, non-revealing message when a download is refused", async () => {
    const server = explorerServer("CUSTOMER_USER");
    server.on("GET", /\/documents\/d-1\/download$/, () => {
      throw new HttpError(404, "NOT_FOUND", "Document not found");
    });
    renderApp("/documents");
    await userEvent.click(await screen.findByRole("button", { name: "Download Annual Report.pdf" }));
    expect(await screen.findByText("The item could not be found, or you do not have access to it.")).toBeInTheDocument();
  });

  it("shows an error state with retry when documents fail to load", async () => {
    const server = explorerServer("CUSTOMER_USER");
    let fail = true;
    server.on("GET", /\/documents$/, () => {
      if (fail) throw new HttpError(503, "STORAGE_UNAVAILABLE", "The document storage service is temporarily unavailable. Please try again.");
      return paged([doc]);
    });
    renderApp("/documents");
    expect(await screen.findByText(/temporarily unavailable/)).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]!);
    expect(await screen.findByText("Annual Report.pdf")).toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    explorerServer("CUSTOMER_USER", []);
    renderApp("/documents?folder=f-reports");
    expect(await screen.findByText("This folder has no documents yet.")).toBeInTheDocument();
  });

  it("sends search, sort and folder filters to the server", async () => {
    const server = explorerServer("CUSTOMER_USER");
    renderApp("/documents?folder=f-reports");
    await screen.findByText("Annual Report.pdf");
    await userEvent.type(screen.getByLabelText("Search documents by name"), "annual");
    await userEvent.click(screen.getByRole("button", { name: /^Size/ }));
    await waitFor(() => {
      const last = server.calls.filter((c) => c.path.includes("/documents?")).at(-1)!;
      expect(last.path).toContain("q=annual");
      expect(last.path).toContain("sort=size");
      expect(last.path).toContain("folderId=f-reports");
    });
  });

  it("renders breadcrumbs for nested folders", async () => {
    explorerServer("CUSTOMER_USER");
    renderApp("/documents?folder=f-2024");
    const crumbs = await screen.findByRole("navigation", { name: "Breadcrumb" });
    await waitFor(() => expect(within(crumbs).getByText("Reports")).toBeInTheDocument());
    expect(within(crumbs).getByText("2024")).toHaveAttribute("aria-current", "page");
  });
});

describe("login", () => {
  it("shows the generic error on failed sign-in and clears the password", async () => {
    const server = mockServer(null);
    server.on("POST", /\/auth\/login$/, () => {
      throw new HttpError(401, "UNAUTHENTICATED", "Invalid email or password, or the account is not available.");
    });
    renderApp("/login");
    await userEvent.type(await screen.findByLabelText("Email address"), "a@b.test");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText(/Invalid email or password/)).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("");
  });

  it("validates fields before submitting", async () => {
    const server = mockServer(null);
    renderApp("/login");
    await userEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter a valid email address")).toBeInTheDocument();
    expect(server.calls.some((c) => c.path.endsWith("/auth/login"))).toBe(false);
  });

  it("sends the CSRF token on state-changing requests after sign-in", async () => {
    const user = makeUser("CUSTOMER_USER");
    const server = mockServer(null);
    server.on("POST", /\/auth\/login$/, () => ({ user, csrfToken: "csrf-123", features: { activityAccess: false } }));
    server.on("GET", /\/folders$/, () => []);
    server.on("GET", /\/documents$/, () => paged([]));
    server.on("POST", /\/auth\/logout$/, () => undefined);
    renderApp("/login");
    await userEvent.type(await screen.findByLabelText("Email address"), "user@antrix.test");
    await userEvent.type(screen.getByLabelText("Password"), "Correct-Horse-1");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    const fetchMock = vi.mocked(fetch);
    const logoutCall = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/auth/logout"))!;
    expect((logoutCall[1] as RequestInit).headers).toMatchObject({ "X-CSRF-Token": "csrf-123" });
  });
});
