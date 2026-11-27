import type { Db } from "../db/app.js";
import type { StrategyDeclaration } from "../strategies/types.js";
import { newId } from "../util/crypto.js";

export interface StrategyRow {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  latest_version: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface StrategyVersionRow {
  strategy_id: string;
  version: number;
  code: string;
  note: string | null;
  declaration_json: string;
  connection_id: string | null;
  created_at: number;
}

export interface RunLimits {
  /** Stop the run when equity falls this many percent below its start (default 10). */
  maxDrawdownPct?: number;
  /** Stop the run when today's loss exceeds this many percent of equity at the day's start (default 5). */
  maxDailyLossPct?: number;
  /** Maximum position notional as a multiple of equity (default 3). */
  maxLeverage?: number;
  /** Maximum order intents per minute (default 20). */
  maxOrdersPerMinute?: number;
}

export interface StrategyRunRow {
  id: string;
  strategy_id: string;
  version: number;
  user_id: string;
  account_id: string;
  connection_id: string | null;
  mode: "paper" | "live";
  status: "running" | "stopped" | "error";
  params_json: string;
  limits_json: string;
  state_json: string;
  broker_json: string | null;
  currency: string | null;
  start_equity: number | null;
  last_equity: number | null;
  started_at: number;
  stopped_at: number | null;
  stop_reason: string | null;
  updated_at: number;
}

export interface RunFillRow {
  t: number;
  instrument_id: string;
  side: string;
  size: number;
  price: number;
  fee: number | null;
  pnl: number | null;
  reason: string | null;
  tag: string | null;
  order_id: string | null;
}

const parse = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

export class StrategyRepo {
  constructor(private readonly db: Db) {}

  // --- strategies & versions ------------------------------------------------------

  create(userId: string, name: string, description: string | null): StrategyRow {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare("INSERT INTO strategies (id, user_id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, userId, name.slice(0, 120), description?.slice(0, 2000) ?? null, now, now);
    return this.find(id, userId)!;
  }

  find(id: string, userId: string): StrategyRow | undefined {
    return this.db.prepare<[string, string], StrategyRow>("SELECT * FROM strategies WHERE id = ? AND user_id = ?").get(id, userId);
  }

  list(userId: string, includeArchived = false): StrategyRow[] {
    return this.db
      .prepare<[string, number], StrategyRow>("SELECT * FROM strategies WHERE user_id = ? AND (archived = 0 OR ?) ORDER BY updated_at DESC")
      .all(userId, includeArchived ? 1 : 0);
  }

  update(id: string, userId: string, fields: { name?: string; description?: string | null; archived?: boolean }): void {
    const s = this.find(id, userId);
    if (!s) return;
    this.db
      .prepare("UPDATE strategies SET name = ?, description = ?, archived = ?, updated_at = ? WHERE id = ? AND user_id = ?")
      .run(
        fields.name?.slice(0, 120) ?? s.name,
        fields.description === undefined ? s.description : (fields.description?.slice(0, 2000) ?? null),
        fields.archived === undefined ? s.archived : fields.archived ? 1 : 0,
        Date.now(),
        id,
        userId,
      );
  }

  addVersion(strategyId: string, code: string, note: string | null, declaration: StrategyDeclaration, connectionId: string | null): number {
    return this.db.transaction(() => {
      const row = this.db.prepare<[string], { v: number }>("SELECT latest_version AS v FROM strategies WHERE id = ?").get(strategyId);
      const version = (row?.v ?? 0) + 1;
      const now = Date.now();
      this.db
        .prepare("INSERT INTO strategy_versions (strategy_id, version, code, note, declaration_json, connection_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(strategyId, version, code, note?.slice(0, 2000) ?? null, JSON.stringify(declaration), connectionId, now);
      this.db.prepare("UPDATE strategies SET latest_version = ?, updated_at = ? WHERE id = ?").run(version, now, strategyId);
      return version;
    })();
  }

  version(strategyId: string, version: number): StrategyVersionRow | undefined {
    return this.db
      .prepare<[string, number], StrategyVersionRow>("SELECT * FROM strategy_versions WHERE strategy_id = ? AND version = ?")
      .get(strategyId, version);
  }

  versions(strategyId: string): Omit<StrategyVersionRow, "code">[] {
    return this.db
      .prepare<[string], Omit<StrategyVersionRow, "code">>(
        "SELECT strategy_id, version, note, declaration_json, connection_id, created_at FROM strategy_versions WHERE strategy_id = ? ORDER BY version DESC",
      )
      .all(strategyId);
  }

  // --- backtests -----------------------------------------------------------------------

  addBacktest(strategyId: string, version: number, accountId: string | null, request: unknown, summary: unknown): string {
    const id = newId();
    this.db
      .prepare("INSERT INTO strategy_backtests (id, strategy_id, version, account_id, request_json, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, strategyId, version, accountId, JSON.stringify(request), JSON.stringify(summary), Date.now());
    return id;
  }

  backtests(strategyId: string, limit = 20): { id: string; version: number; account_id: string | null; request: unknown; summary: unknown; created_at: number }[] {
    return this.db
      .prepare<[string, number], { id: string; version: number; account_id: string | null; request_json: string; summary_json: string; created_at: number }>(
        "SELECT * FROM strategy_backtests WHERE strategy_id = ? ORDER BY created_at DESC LIMIT ?",
      )
      .all(strategyId, limit)
      .map((r) => ({ id: r.id, version: r.version, account_id: r.account_id, request: parse(r.request_json, {}), summary: parse(r.summary_json, {}), created_at: r.created_at }));
  }

  // --- runs -------------------------------------------------------------------------------

  createRun(input: {
    strategyId: string;
    version: number;
    userId: string;
    accountId: string;
    connectionId: string | null;
    mode: "paper" | "live";
    params: Record<string, unknown>;
    limits: RunLimits;
    currency: string | null;
    startEquity: number | null;
  }): StrategyRunRow {
    const id = newId();
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO strategy_runs (id, strategy_id, version, user_id, account_id, connection_id, mode, status, params_json, limits_json,
           currency, start_equity, last_equity, started_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.strategyId,
        input.version,
        input.userId,
        input.accountId,
        input.connectionId,
        input.mode,
        JSON.stringify(input.params),
        JSON.stringify(input.limits),
        input.currency,
        input.startEquity,
        input.startEquity,
        now,
        now,
      );
    return this.run(id)!;
  }

  run(id: string): StrategyRunRow | undefined {
    return this.db.prepare<[string], StrategyRunRow>("SELECT * FROM strategy_runs WHERE id = ?").get(id);
  }

  runForUser(id: string, userId: string): StrategyRunRow | undefined {
    const r = this.run(id);
    return r && r.user_id === userId ? r : undefined;
  }

  runs(filter: { userId?: string; strategyId?: string; status?: StrategyRunRow["status"]; limit?: number }): StrategyRunRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.userId) {
      where.push("user_id = ?");
      args.push(filter.userId);
    }
    if (filter.strategyId) {
      where.push("strategy_id = ?");
      args.push(filter.strategyId);
    }
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    args.push(filter.limit ?? 100);
    return this.db
      .prepare<(string | number)[], StrategyRunRow>(`SELECT * FROM strategy_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY started_at DESC LIMIT ?`)
      .all(...args);
  }

  saveRunState(id: string, fields: { state?: unknown; broker?: unknown; lastEquity?: number | null }): void {
    const r = this.run(id);
    if (!r) return;
    this.db
      .prepare("UPDATE strategy_runs SET state_json = ?, broker_json = ?, last_equity = ?, updated_at = ? WHERE id = ?")
      .run(
        fields.state === undefined ? r.state_json : JSON.stringify(fields.state),
        fields.broker === undefined ? r.broker_json : JSON.stringify(fields.broker),
        fields.lastEquity === undefined ? r.last_equity : fields.lastEquity,
        Date.now(),
        id,
      );
  }

  finishRun(id: string, status: "stopped" | "error", reason: string): void {
    this.db
      .prepare("UPDATE strategy_runs SET status = ?, stop_reason = ?, stopped_at = ?, updated_at = ? WHERE id = ? AND status = 'running'")
      .run(status, reason.slice(0, 1000), Date.now(), Date.now(), id);
  }

  addLog(runId: string, t: number, msg: string): void {
    this.db.prepare("INSERT INTO strategy_run_logs (run_id, t, msg) VALUES (?, ?, ?)").run(runId, t, msg.slice(0, 2000));
  }

  logs(runId: string, limit = 100): { t: number; msg: string }[] {
    return this.db
      .prepare<[string, number], { t: number; msg: string }>("SELECT t, msg FROM strategy_run_logs WHERE run_id = ? ORDER BY id DESC LIMIT ?")
      .all(runId, limit)
      .reverse();
  }

  addFill(runId: string, f: RunFillRow): void {
    this.db
      .prepare("INSERT INTO strategy_run_fills (run_id, t, instrument_id, side, size, price, fee, pnl, reason, tag, order_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(runId, f.t, f.instrument_id, f.side, f.size, f.price, f.fee, f.pnl, f.reason, f.tag, f.order_id);
  }

  fills(runId: string, limit = 100): RunFillRow[] {
    return this.db
      .prepare<[string, number], RunFillRow>(
        "SELECT t, instrument_id, side, size, price, fee, pnl, reason, tag, order_id FROM strategy_run_fills WHERE run_id = ? ORDER BY id DESC LIMIT ?",
      )
      .all(runId, limit)
      .reverse();
  }

  fillStats(runId: string): { closes: number; wins: number; pnl: number; fees: number } {
    return this.db
      .prepare<[string], { closes: number; wins: number; pnl: number; fees: number }>(
        `SELECT COALESCE(SUM(CASE WHEN pnl != 0 THEN 1 ELSE 0 END), 0) AS closes, COALESCE(SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END), 0) AS wins,
                COALESCE(SUM(pnl), 0) AS pnl, COALESCE(SUM(fee), 0) AS fees FROM strategy_run_fills WHERE run_id = ?`,
      )
      .get(runId)!;
  }

  addEquity(runId: string, ts: number, equity: number): void {
    this.db.prepare("INSERT OR REPLACE INTO strategy_run_equity (run_id, ts, equity) VALUES (?, ?, ?)").run(runId, ts, equity);
  }

  equity(runId: string, maxPoints = 300): { t: number; v: number }[] {
    const rows = this.db.prepare<[string], { ts: number; equity: number }>("SELECT ts, equity FROM strategy_run_equity WHERE run_id = ? ORDER BY ts").all(runId);
    if (rows.length <= maxPoints) return rows.map((r) => ({ t: r.ts, v: r.equity }));
    const step = (rows.length - 1) / (maxPoints - 1);
    return Array.from({ length: maxPoints }, (_, i) => rows[Math.round(i * step)]!).map((r) => ({ t: r.ts, v: r.equity }));
  }

  /** Keeps logs bounded per run. */
  prune(runId: string, keepLogs = 2000): void {
    this.db
      .prepare("DELETE FROM strategy_run_logs WHERE run_id = ? AND id <= (SELECT id FROM strategy_run_logs WHERE run_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)")
      .run(runId, runId, keepLogs);
  }
}

export function runParams(r: StrategyRunRow): Record<string, unknown> {
  return parse(r.params_json, {});
}
export function runLimits(r: StrategyRunRow): RunLimits {
  return parse(r.limits_json, {});
}
export function runState(r: StrategyRunRow): Record<string, unknown> {
  return parse(r.state_json, {});
}
export function versionDeclaration(v: Pick<StrategyVersionRow, "declaration_json">): StrategyDeclaration {
  return parse(v.declaration_json, { name: null, params: {}, data: [], ticks: [], handlers: [] });
}
