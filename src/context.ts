import type { Config } from "./config.js";
import type { Db } from "./db/app.js";
import { AccountRepo } from "./repos/accounts.js";
import { ActivityRepo } from "./repos/activity.js";
import { ConnectionRepo } from "./repos/connections.js";
import { OAuthClientRepo } from "./repos/oauthClients.js";
import { PnlRepo } from "./repos/pnl.js";
import { StrategyRepo } from "./repos/strategies.js";
import { UserRepo, WebSessionRepo } from "./repos/users.js";
import { AccountService, SqliteQuotaStore } from "./services/accountService.js";
import { CandleCache } from "./services/candleCache.js";
import { StrategyService } from "./services/strategies.js";
import { StreamService } from "./services/streams.js";
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
  streams: StreamService;
  strategies: StrategyService;
}

export function createContext(config: Config, db: Db, marketDb: Db): AppContext {
  const accounts = new AccountRepo(db, config.encryptionKey);
  const pnl = new PnlRepo(db);
  const accountService = new AccountService(accounts, new SqliteQuotaStore(marketDb));
  const candles = new CandleCache(marketDb);
  const activity = new ActivityRepo(db);
  const connections = new ConnectionRepo(db);
  const streams = new StreamService(accounts, accountService, candles);
  const strategies = new StrategyService(new StrategyRepo(db), accounts, accountService, candles, streams, activity, connections);
  return {
    config,
    db,
    marketDb,
    users: new UserRepo(db),
    webSessions: new WebSessionRepo(db),
    oauthClients: new OAuthClientRepo(db),
    connections,
    accounts,
    activity,
    pnl,
    accountService,
    candles,
    sync: new SyncService(accounts, pnl, accountService, config.snapshotIntervalMs, config.pnlSyncIntervalMs),
    streams,
    strategies,
  };
}
