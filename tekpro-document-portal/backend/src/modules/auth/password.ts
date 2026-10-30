import argon2 from "argon2";
import { badRequest } from "../../utils/errors.js";

/** OWASP-recommended Argon2id parameters (19 MiB memory, 2 iterations). */
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, ARGON2_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;
/** Burns comparable CPU time when the account does not exist, to limit user enumeration by timing. */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword("dummy-password-for-timing-equalisation");
  await verifyPassword(await dummyHash, password);
}

export function validatePasswordStrength(password: string, minLength: number, email?: string): void {
  if (password.length < minLength) throw badRequest(`Password must be at least ${minLength} characters long`);
  if (password.length > 256) throw badRequest("Password must be at most 256 characters long");
  if (/^(.)\1*$/.test(password)) throw badRequest("Password must not be a single repeated character");
  if (email && password.toLowerCase().includes(email.toLowerCase().split("@")[0]!) && email.split("@")[0]!.length >= 4) {
    throw badRequest("Password must not contain your email name");
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length;
  if (classes < 3) {
    throw badRequest("Password must contain at least three of: lower-case letters, upper-case letters, digits, symbols");
  }
}
