import type { Db } from "../db/app.js";

export interface ToolCallRow {
  id: number;
  user_id: string;
  connection_id: string | null;
  account_id: string | null;
  tool: string;
  is_trade: number;
  args_json: string;
  result_json: string | null;
  ok: number;
  error: string | null;
  duration_ms: number;
  created_at: number;
}

export interface ToolCallFilter {
  userId: string;
  accountId?: string;
  connectionId?: string;
  tradesOnly?: boolean;
  errorsOnly?: boolean;
  before?: number;
  limit: number;
}

export class ActivityRepo {
  constructor(private readonly db: Db) {}

  recordToolCall(input: Omit<ToolCallRow, "id">): void {
    this.db
      .prepare(
        `INSERT INTO tool_calls (user_id, connection_id, account_id, tool, is_trade, args_json, result_json, ok, error, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.user_id,
        input.connection_id,
        input.account_id,
        input.tool,
        input.is_trade,
        input.args_json,
        input.result_json,
        input.ok,
        input.error,
        input.duration_ms,
        input.created_at,
      );
  }

  listToolCalls(f: ToolCallFilter): ToolCallRow[] {
    const where = ["user_id = ?"];
    const params: (string | number)[] = [f.userId];
    if (f.accountId) {
      where.push("account_id = ?");
      params.push(f.accountId);
    }
    if (f.connectionId) {
      where.push("connection_id = ?");
      params.push(f.connectionId);
    }
    if (f.tradesOnly) where.push("is_trade = 1");
    if (f.errorsOnly) where.push("ok = 0");
    if (f.before) {
      where.push("id < ?");
      params.push(f.before);
    }
    params.push(f.limit);
    return this.db
      .prepare<(string | number)[], ToolCallRow>(`SELECT * FROM tool_calls WHERE ${where.join(" AND ")} ORDER BY id DESC LIMIT ?`)
      .all(...params);
  }

  getToolCall(id: number, userId: string): ToolCallRow | undefined {
    return this.db.prepare<[number, string], ToolCallRow>("SELECT * FROM tool_calls WHERE id = ? AND user_id = ?").get(id, userId);
  }

  countSince(userId: string, since: number): { calls: number; trades: number; errors: number } {
    return this.db
      .prepare<[string, number], { calls: number; trades: number; errors: number }>(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(is_trade), 0) AS trades, COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END), 0) AS errors
           FROM tool_calls WHERE user_id = ? AND created_at >= ?`,
      )
      .get(userId, since)!;
  }

  recordAgentOrder(input: { accountId: string; connectionId: string | null; orderId: string; instrumentId: string }): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO agent_orders (account_id, connection_id, order_id, instrument_id, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(input.accountId, input.connectionId, input.orderId, input.instrumentId, Date.now());
  }

  agentOrderIds(accountId: string, orderIds: string[]): Set<string> {
    if (orderIds.length === 0) return new Set();
    const placeholders = orderIds.map(() => "?").join(",");
    return new Set(
      this.db
        .prepare<string[], { order_id: string }>(`SELECT order_id FROM agent_orders WHERE account_id = ? AND order_id IN (${placeholders})`)
        .all(accountId, ...orderIds)
        .map((r) => r.order_id),
    );
  }

  audit(input: { userId: string | null; action: string; detail?: Record<string, unknown>; ip?: string | null }): void {
    this.db
      .prepare("INSERT INTO audit_events (user_id, action, detail_json, ip, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(input.userId, input.action, input.detail ? JSON.stringify(input.detail) : null, input.ip ?? null, Date.now());
  }

  listAudit(limit: number): { id: number; user_id: string | null; username: string | null; action: string; detail_json: string | null; ip: string | null; created_at: number }[] {
    return this.db
      .prepare<[number], { id: number; user_id: string | null; username: string | null; action: string; detail_json: string | null; ip: string | null; created_at: number }>(
        `SELECT e.*, u.username FROM audit_events e LEFT JOIN users u ON u.id = e.user_id ORDER BY e.id DESC LIMIT ?`,
      )
      .all(limit);
  }

  purge(toolCallRetentionDays: number): void {
    const cutoff = Date.now() - toolCallRetentionDays * 86_400_000;
    this.db.prepare("DELETE FROM tool_calls WHERE created_at < ?").run(cutoff);
    this.db.prepare("DELETE FROM audit_events WHERE created_at < ?").run(cutoff);
  }
}
