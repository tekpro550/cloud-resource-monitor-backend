import type { Principal } from "./context.js";

declare global {
  namespace Express {
    interface Request {
      id: string;
      principal?: Principal;
    }
  }
}

export {};
