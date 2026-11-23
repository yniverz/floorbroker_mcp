import type { Config } from "./config.js";
import type { Db } from "./db/app.js";
import { AccountRepo } from "./repos/accounts.js";
import { ActivityRepo } from "./repos/activity.js";
import { ConnectionRepo } from "./repos/connections.js";
import { OAuthClientRepo } from "./repos/oauthClients.js";
import { PnlRepo } from "./repos/pnl.js";
import { UserRepo, WebSessionRepo } from "./repos/users.js";
import { AccountService, SqliteQuotaStore } from "./services/accountService.js";
import { CandleCache } from "./services/candleCache.js";
import { SyncService } from "./services/sync.js";

export interface AppContext {
  config: Config;
  db: Db;
  marketDb: Db;
  users: UserRepo;
  webSessions: WebSessionRepo;
  oauthClients: OAuthClientRepo;
  connections: ConnectionRepo;
  accounts: AccountRepo;
  activity: ActivityRepo;
  pnl: PnlRepo;
  accountService: AccountService;
  candles: CandleCache;
  sync: SyncService;
}

export function createContext(config: Config, db: Db, marketDb: Db): AppContext {
  const accounts = new AccountRepo(db, config.encryptionKey);
  const pnl = new PnlRepo(db);
  const accountService = new AccountService(accounts, new SqliteQuotaStore(marketDb));
  return {
    config,
    db,
    marketDb,
    users: new UserRepo(db),
    webSessions: new WebSessionRepo(db),
    oauthClients: new OAuthClientRepo(db),
    connections: new ConnectionRepo(db),
    accounts,
    activity: new ActivityRepo(db),
    pnl,
    accountService,
    candles: new CandleCache(marketDb),
    sync: new SyncService(accounts, pnl, accountService, config.snapshotIntervalMs, config.pnlSyncIntervalMs),
  };
}
