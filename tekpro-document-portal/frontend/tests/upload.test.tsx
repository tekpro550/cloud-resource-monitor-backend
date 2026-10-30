import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UploadPanel } from "../src/features/explorer/UploadPanel";
import { startUpload } from "../src/services/uploader";
import { formatBytes } from "../src/utils/format";
import { HttpError, makeUser, mockServer } from "./helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Minimal XMLHttpRequest double that records PUTs and lets tests drive progress. */
class FakeXHR {
  static instances: FakeXHR[] = [];
  upload: { onprogress: ((e: { loaded: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: Blob | null = null;
  responseHeaders: Record<string, string> = {};
  constructor() {
    FakeXHR.instances.push(this);
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(k: string, v: string) {
    this.headers[k] = v;
  }
  getResponseHeader(k: string) {
    return this.responseHeaders[k.toLowerCase()] ?? null;
  }
  send(body: Blob) {
    this.body = body;
  }
  abort() {
    this.onabort?.();
  }
  succeed(etag = '"etag"') {
    this.upload.onprogress?.({ loaded: this.body?.size ?? 0 });
    this.status = 200;
    this.responseHeaders.etag = etag;
    this.onload?.();
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("direct-to-storage uploader", () => {
  it("single upload: initiate, PUT with signed headers, then server-side completion", async () => {
    FakeXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const server = mockServer(makeUser("TEKPRO_USER"));
    server.on("POST", /\/uploads\/initiate$/, () => ({
      uploadId: "up-1",
      documentId: "doc-1",
      mode: "SINGLE",
      expiresAt: "",
      upload: { url: "https://bucket.example/put", method: "PUT", headers: { "Content-Type": "application/pdf" }, expiresAt: "" },
    }));
    server.on("POST", /\/uploads\/up-1\/complete$/, () => ({ id: "doc-1", status: "AVAILABLE" }));

    const progress: number[] = [];
    const file = new File(["%PDF-1.7 hello"], "a.pdf", { type: "application/pdf" });
    const handle = startUpload("c1", "f1", file, (p) => progress.push(p.loaded));
    await flush();
    await flush();
    const xhr = FakeXHR.instances[0]!;
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe("https://bucket.example/put");
    expect(xhr.headers["Content-Type"]).toBe("application/pdf");
    xhr.succeed();
    await expect(handle.promise).resolves.toMatchObject({ status: "AVAILABLE" });
    expect(progress.at(-1)).toBe(file.size);
    const initiate = server.calls.find((c) => c.path.endsWith("/initiate"))!;
    expect(initiate.body).toEqual({ folderId: "f1", filename: "a.pdf", sizeBytes: file.size });
  });

  it("multipart upload slices the file, collects ETags and completes with all parts", async () => {
    FakeXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const server = mockServer(makeUser("TEKPRO_USER"));
    server.on("POST", /\/uploads\/initiate$/, () => ({ uploadId: "up-2", documentId: "doc-2", mode: "MULTIPART", expiresAt: "", partSize: 4, partCount: 3 }));
    server.on("POST", /\/uploads\/up-2\/parts$/, (_u, init) => ({
      parts: (JSON.parse(String(init.body)).partNumbers as number[]).map((n) => ({ partNumber: n, url: `https://bucket.example/part${n}`, method: "PUT", expiresAt: "" })),
    }));
    server.on("POST", /\/uploads\/up-2\/complete$/, () => ({ id: "doc-2", status: "AVAILABLE" }));

    const file = new File(["0123456789"], "big.zip");
    const handle = startUpload("c1", "f1", file, () => undefined);
    for (let i = 0; i < 20 && FakeXHR.instances.length < 3; i++) await flush();
    expect(FakeXHR.instances.map((x) => x.body?.size)).toEqual([4, 4, 2]);
    FakeXHR.instances.forEach((x, i) => x.succeed(`"e${i + 1}"`));
    await expect(handle.promise).resolves.toMatchObject({ id: "doc-2" });
    const complete = server.calls.find((c) => c.path.endsWith("/complete"))!;
    expect(complete.body).toEqual({
      parts: [
        { partNumber: 1, etag: '"e1"' },
        { partNumber: 2, etag: '"e2"' },
        { partNumber: 3, etag: '"e3"' },
      ],
    });
  });

  it("cancelling aborts the transfer and tells the server", async () => {
    FakeXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const server = mockServer(makeUser("TEKPRO_USER"));
    server.on("POST", /\/uploads\/initiate$/, () => ({
      uploadId: "up-3",
      documentId: "doc-3",
      mode: "SINGLE",
      expiresAt: "",
      upload: { url: "https://bucket.example/put", method: "PUT", headers: {}, expiresAt: "" },
    }));
    server.on("POST", /\/uploads\/up-3\/abort$/, () => undefined);
    const handle = startUpload("c1", "f1", new File(["x"], "x.pdf"), () => undefined);
    await flush();
    await flush();
    handle.cancel();
    await expect(handle.promise).rejects.toThrow("Upload cancelled");
    expect(server.calls.some((c) => c.path.endsWith("/up-3/abort"))).toBe(true);
  });
});

describe("UploadPanel", () => {
  it("asks for a folder before allowing uploads", () => {
    render(<UploadPanel customerId="c1" folderId={null} onUploaded={() => undefined} />);
    expect(screen.getByText("Select a folder to upload documents.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Choose files" })).not.toBeInTheDocument();
  });

  it("shows server-side validation errors for a rejected file and offers retry", async () => {
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    const server = mockServer(makeUser("TEKPRO_USER"));
    server.on("POST", /\/uploads\/initiate$/, () => {
      throw new HttpError(415, "FILE_TYPE_NOT_ALLOWED", "Files of type .exe are not allowed");
    });
    const onUploaded = vi.fn();
    render(<UploadPanel customerId="c1" folderId="f1" folderName="Reports" onUploaded={onUploaded} />);
    await userEvent.upload(screen.getByTestId("file-input"), new File(["MZ"], "setup.exe"));
    expect(await screen.findByText(/Failed: Files of type \.exe are not allowed/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(onUploaded).not.toHaveBeenCalled();
  });
});

describe("formatting", () => {
  it("formats file sizes consistently", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

