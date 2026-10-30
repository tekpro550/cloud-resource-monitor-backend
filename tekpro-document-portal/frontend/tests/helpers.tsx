import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { vi } from "vitest";
import { App } from "../src/App";
import { AuthProvider } from "../src/hooks/useAuth";
import type { Role, User } from "../src/types/api";

export const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

export function makeUser(role: Role): User {
  const customer = role === "CUSTOMER_ADMIN" || role === "CUSTOMER_USER" ? { id: CUSTOMER_ID, name: "Antrix", customerCode: "ANTRIX" } : null;
  return {
    id: `user-${role}`,
    email: `${role.toLowerCase()}@example.test`,
    fullName: `Test ${role}`,
    role,
    status: "ACTIVE",
    customerId: customer?.id ?? null,
    customer,
    passwordSet: true,
    locked: false,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    lastLoginAt: null,
  };
}

type Handler = (url: URL, init: RequestInit) => unknown;
export interface MockServer {
  calls: { method: string; path: string; body?: unknown }[];
  on: (method: string, pathPattern: RegExp, handler: Handler) => void;
}

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export class HttpError {
  constructor(
    public status: number,
    public code: string,
    public message: string,
  ) {}
}

/** Installs a fetch mock; handlers return `data` or throw HttpError. */
export function mockServer(user: User | null, activityAccess = false): MockServer {
  const routes: { method: string; pattern: RegExp; handler: Handler }[] = [];
  const calls: MockServer["calls"] = [];
  const server: MockServer = { calls, on: (method, pattern, handler) => routes.unshift({ method, pattern, handler }) };
  server.on("GET", /^\/api\/v1\/auth\/me$/, () => {
    if (!user) throw new HttpError(401, "UNAUTHENTICATED", "Authentication required");
    return { user, csrfToken: "csrf-test", features: { activityAccess } };
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input, "http://localhost");
      const method = init.method ?? "GET";
      calls.push({ method, path: url.pathname + url.search, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const route = routes.find((r) => r.method === method && r.pattern.test(url.pathname));
      if (!route) return json(404, { error: { code: "NOT_FOUND", message: "not mocked" } });
      try {
        const data = await route.handler(url, init);
        return data === undefined ? json(204, null) : json(200, { data });
      } catch (e) {
        if (e instanceof HttpError) return json(e.status, { error: { code: e.code, message: e.message } });
        throw e;
      }
    }),
  );
  return server;
}

export function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

export const paged = <T,>(items: T[]) => ({ items, pagination: { page: 1, pageSize: 25, total: items.length, totalPages: 1 } });
