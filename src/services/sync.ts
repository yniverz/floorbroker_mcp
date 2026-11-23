import { logger } from "../logger.js";
import type { AccountRepo, PlatformAccountRow } from "../repos/accounts.js";
import type { PnlRepo } from "../repos/pnl.js";
import type { AccountService } from "./accountService.js";

/**
 * Background jobs: equity snapshots (for the equity curve) and realized PnL sync
 * from each platform's history. Runs per account, sequentially, to stay gentle on rate limits.
 */
export class SyncService {
  private timers: NodeJS.Timeout[] = [];
  private running = new Set<string>();

  constructor(
    private readonly accounts: AccountRepo,
    private readonly pnl: PnlRepo,
    private readonly service: AccountService,
    private readonly snapshotIntervalMs: number,
    private readonly pnlSyncIntervalMs: number,
  ) {}

  start(): void {
    const kick = setTimeout(() => {
      void this.runAll("snapshot");
      void this.runAll("pnl");
    }, 10_000);
    this.timers.push(kick);
    this.timers.push(setInterval(() => void this.runAll("snapshot"), this.snapshotIntervalMs));
    this.timers.push(setInterval(() => void this.runAll("pnl"), this.pnlSyncIntervalMs));
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private async runAll(job: "snapshot" | "pnl"): Promise<void> {
    if (this.running.has(job)) return;
    this.running.add(job);
    try {
      for (const row of this.accounts.listActive()) {
        try {
          if (job === "snapshot") await this.snapshot(row);
          else await this.syncPnl(row);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn(`${job} failed`, { account: row.id, platform: row.platform, err: msg });
          this.accounts.setError(row.id, `${job === "snapshot" ? "Balance update" : "PnL sync"} failed: ${msg}`);
        }
      }
    } finally {
      this.running.delete(job);
    }
  }

  async snapshot(row: PlatformAccountRow): Promise<void> {
    const client = this.service.client(row);
    const acct = await client.getAccount();
    let positions: number | null = null;
    try {
      positions = (await client.getPositions({})).length;
    } catch {
      positions = null;
    }
    this.pnl.addSnapshot({
      account_id: row.id,
      ts: Date.now(),
      currency: acct.currency,
      equity: acct.equity,
      balance: acct.balance,
      unrealized_pnl: acct.unrealizedPnl,
      positions,
    });
    if (row.last_error) this.accounts.setError(row.id, null);
  }

  async syncPnl(row: PlatformAccountRow): Promise<void> {
    const client = this.service.client(row);
    const last = Number(this.pnl.getSyncState(row.id, "closed_pnl_until") ?? 0);
    // First sync looks back 90 days; later syncs overlap by one day to catch late records.
    const from = last > 0 ? last - 86_400_000 : Date.now() - 90 * 86_400_000;
    const to = Date.now();
    let inserted = 0;
    let windowTo = to;
    // Page backwards while a page comes back full.
    for (let page = 0; page < 20; page++) {
      const records = await client.getClosedPnl({ from, to: windowTo, limit: 500 });
      inserted += this.pnl.upsertClosedPnl(row.id, records);
      if (records.length < 500) break;
      const oldest = Math.min(...records.map((r) => r.closedAt));
      if (!(oldest > from) || oldest >= windowTo) break;
      windowTo = oldest + 1;
    }
    this.pnl.setSyncState(row.id, "closed_pnl_until", String(to));
    if (inserted > 0) logger.info("closed pnl synced", { account: row.id, inserted });
  }
}
