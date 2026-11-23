import type { Db } from "../db/app.js";
import { newId, randomToken, sha256 } from "../util/crypto.js";

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: "admin" | "user";
  is_active: number;
  must_change_password: number;
  failed_logins: number;
  locked_until: number | null;
  created_at: number;
  last_login_at: number | null;
}

export interface WebSessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  csrf_secret: string;
  ip: string | null;
  user_agent: string | null;
  created_at: number;
  last_seen_at: number;
  absolute_exp: number;
  revoked_at: number | null;
}

export class UserRepo {
  constructor(private readonly db: Db) {}

  count(): number {
    return this.db.prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM users").get()!.c;
  }

  list(): UserRow[] {
    return this.db.prepare<[], UserRow>("SELECT * FROM users ORDER BY created_at").all();
  }

  findById(id: string): UserRow | undefined {
    return this.db.prepare<[string], UserRow>("SELECT * FROM users WHERE id = ?").get(id);
  }

  findByUsername(username: string): UserRow | undefined {
    return this.db.prepare<[string], UserRow>("SELECT * FROM users WHERE username = ?").get(username);
  }

  create(input: { username: string; passwordHash: string; role: "admin" | "user"; mustChange: boolean }): UserRow {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, role, is_active, must_change_password, created_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(id, input.username, input.passwordHash, input.role, input.mustChange ? 1 : 0, Date.now());
    return this.findById(id)!;
  }

  setPassword(id: string, hash: string, mustChange: boolean): void {
    this.db
      .prepare("UPDATE users SET password_hash = ?, must_change_password = ?, failed_logins = 0, locked_until = NULL WHERE id = ?")
      .run(hash, mustChange ? 1 : 0, id);
  }

  setActive(id: string, active: boolean): void {
    this.db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(active ? 1 : 0, id);
  }

  setRole(id: string, role: "admin" | "user"): void {
    this.db.prepare("UPDATE users SET role = ? WHERE id = ?").run(role, id);
  }

  delete(id: string): void {
    this.db.prepare("DELETE FROM users WHERE id = ?").run(id);
  }

  isLocked(user: UserRow): boolean {
    return user.locked_until !== null && user.locked_until > Date.now();
  }

  registerFailedLogin(id: string, threshold: number, minutes: number): void {
    this.db
      .prepare(
        `UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END
         WHERE id = ?`,
      )
      .run(threshold, Date.now() + minutes * 60_000, id);
  }

  registerSuccessfulLogin(id: string): void {
    this.db
      .prepare("UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }
}

export class WebSessionRepo {
  constructor(private readonly db: Db) {}

  create(input: { userId: string; ip: string | null; userAgent: string | null; absoluteTtlMs: number }): { token: string } {
    const token = randomToken(32);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO web_sessions (id, token_hash, user_id, csrf_secret, ip, user_agent, created_at, last_seen_at, absolute_exp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(newId(), sha256(token), input.userId, randomToken(24), input.ip, input.userAgent?.slice(0, 300) ?? null, now, now, now + input.absoluteTtlMs);
    return { token };
  }

  findByToken(token: string): WebSessionRow | undefined {
    return this.db.prepare<[string], WebSessionRow>("SELECT * FROM web_sessions WHERE token_hash = ?").get(sha256(token));
  }

  touch(id: string): void {
    this.db.prepare("UPDATE web_sessions SET last_seen_at = ? WHERE id = ?").run(Date.now(), id);
  }

  revoke(id: string): void {
    this.db.prepare("UPDATE web_sessions SET revoked_at = ? WHERE id = ?").run(Date.now(), id);
  }

  revokeAllForUser(userId: string, exceptId?: string): void {
    this.db
      .prepare("UPDATE web_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?")
      .run(Date.now(), userId, exceptId ?? "");
  }

  purge(): void {
    this.db.prepare("DELETE FROM web_sessions WHERE absolute_exp < ? OR revoked_at IS NOT NULL").run(Date.now());
  }
}
