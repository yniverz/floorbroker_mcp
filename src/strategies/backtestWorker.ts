import { parentPort, workerData } from "node:worker_threads";
import { runBacktest, type BacktestInput } from "./backtestCore.js";

/** Runs one backtest off the main thread so long backtests never block the server. */
runBacktest(workerData as BacktestInput).then(
  (result) => parentPort!.postMessage({ ok: true, result }),
  (err: unknown) => parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) }),
);
