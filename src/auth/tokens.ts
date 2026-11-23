import { randomBytes } from "node:crypto";
import { sha256 } from "../util/crypto.js";

/**
 * Bearer token format: fb_<kind>_<prefix>_<secret>
 * Only a SHA-256 of the full token is stored; the prefix allows an indexed lookup.
 */
export type TokenKind = "at" | "rt" | "pat";

export interface GeneratedToken {
  value: string;
  prefix: string;
  hash: string;
}

export function generateToken(kind: TokenKind): GeneratedToken {
  const prefix = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const value = `fb_${kind}_${prefix}_${secret}`;
  return { value, prefix, hash: sha256(value) };
}

export function parseToken(raw: string): { kind: TokenKind; prefix: string; hash: string } | null {
  const m = /^fb_(at|rt|pat)_([0-9a-f]{12})_([A-Za-z0-9_-]{40,60})$/.exec(raw.trim());
  if (!m) return null;
  return { kind: m[1] as TokenKind, prefix: m[2]!, hash: sha256(raw.trim()) };
}
