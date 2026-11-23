import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

/** Constant-time comparison that does not leak length via early return. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(sha256(a), "hex");
  const bb = Buffer.from(sha256(b), "hex");
  return timingSafeEqual(ab, bb);
}

/**
 * AES-256-GCM. The associated data binds a ciphertext to its row, so an
 * encrypted credential blob cannot be copied onto another account.
 */
export function encryptJson(key: Buffer, value: unknown, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${ct.toString("base64url")}`;
}

export function decryptJson<T>(key: Buffer, blob: string, aad: string): T {
  const [version, ivB64, tagB64, ctB64] = blob.split(".");
  if (version !== "v1" || !ivB64 || !tagB64 || ctB64 === undefined) throw new Error("Unsupported ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64url"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64url"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ctB64, "base64url")), decipher.final()]);
  return JSON.parse(pt.toString("utf8")) as T;
}
