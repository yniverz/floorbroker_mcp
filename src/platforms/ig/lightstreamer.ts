import { fetch as undiciFetch } from "undici";
import { logger } from "../../logger.js";
import { dispatcherFor } from "../http.js";
import { Backoff, StatusTracker } from "../streamKit.js";

/**
 * Minimal Lightstreamer client for IG's streaming API, using the same text protocol as
 * the owner's Python client (igtrading/streaming.py): a session is created with
 * create_session.txt (a long-lived streaming HTTP response), subscriptions are managed
 * with separate control.txt requests, and LOOP means "rebind to the same session" via
 * bind_session.txt. Unlike the Python client this one also reconnects with a fresh
 * session after END / SYNC ERROR / network errors and resubscribes every table.
 *
 * Update lines look like "<table>,<item>|<v1>|<v2>…"; per field, "" = unchanged,
 * "#" = null, "$" = empty string, and a leading # or $ on a real value is an escape.
 */

const CLIENT_ID = "mgQkwtwdysogQz2BJ4Ji kOj2Bg";

export interface LsCredentials {
  endpoint: string;
  accountId: string;
  password: string;
}

export interface LsTableSpec {
  mode: "MERGE" | "DISTINCT";
  /** Data adapter, when not the default one (e.g. "Pricing" for PRICE items). */
  adapter?: string;
  /** Item names; may depend on the account id known only after login (e.g. "TRADE:<accountId>"). */
  items: (accountId: string) => string[];
  fields: string[];
  /** Called with the 0-based item index and the merged field values. */
  onUpdate: (item: number, values: Record<string, string | null>) => void;
  onError?: (message: string) => void;
}

interface Table extends LsTableSpec {
  state: Map<number, Record<string, string | null>>;
  /** True once added in the current session. */
  live: boolean;
}

class StreamClosed extends Error {
  constructor(
    message: string,
    readonly rebind = false,
    readonly authProblem = false,
  ) {
    super(message);
  }
}

export class LightstreamerClient {
  readonly status = new StatusTracker();
  private readonly tables = new Map<number, Table>();
  private nextTable = 1;
  private running = false;
  private session: { id: string; control: string; accountId: string } | null = null;
  private abort: AbortController | null = null;
  private watchdog: NodeJS.Timeout | null = null;
  private keepaliveMs = 5000;
  private readonly backoff = new Backoff();
  private needFreshLogin = false;

  constructor(
    private readonly name: string,
    private readonly credentials: (fresh: boolean) => Promise<LsCredentials>,
  ) {}

  add(spec: LsTableSpec): number {
    const id = this.nextTable++;
    const table: Table = { ...spec, state: new Map(), live: false };
    this.tables.set(id, table);
    if (!this.running) this.start();
    else if (this.session) void this.addTable(id, table);
    return id;
  }

  remove(id: number): void {
    const table = this.tables.get(id);
    if (!table) return;
    this.tables.delete(id);
    if (this.tables.size === 0) {
      this.stop();
      return;
    }
    if (this.session && table.live) {
      void this.control({ LS_op: "delete", LS_table: String(id) }).catch(() => undefined);
    }
  }

  get tableCount(): number {
    return this.tables.size;
  }

  stop(): void {
    this.running = false;
    const s = this.session;
    this.session = null;
    if (s) void this.controlTo(s, { LS_op: "destroy" }).catch(() => undefined);
    this.abort?.abort();
    this.abort = null;
    this.clearWatchdog();
    this.status.down(null);
    for (const t of this.tables.values()) t.live = false;
  }

  // --- connection loop --------------------------------------------------------

  private start(): void {
    this.running = true;
    void this.loop();
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        await this.runSession();
      } catch (err) {
        if (!this.running) break;
        const e = err instanceof StreamClosed ? err : new StreamClosed(err instanceof Error ? err.message : String(err));
        if (e.authProblem) this.needFreshLogin = true;
        this.status.down(e.message);
        this.session = null;
        this.clearWatchdog();
        for (const t of this.tables.values()) t.live = false;
        const delay = this.backoff.next();
        logger.info("IG stream disconnected, reconnecting", { stream: this.name, reason: e.message, delayMs: delay });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async post(url: string, params: Record<string, string>, signal?: AbortSignal) {
    const body = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "")).toString();
    const dispatcher = dispatcherFor("ig");
    return undiciFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
  }

  private async runSession(): Promise<void> {
    const fresh = this.needFreshLogin;
    this.needFreshLogin = false;
    const creds = await this.credentials(fresh);
    this.abort = new AbortController();
    const res = await this.post(
      `${creds.endpoint.replace(/\/+$/, "")}/lightstreamer/create_session.txt`,
      { LS_op2: "create", LS_cid: CLIENT_ID, LS_user: creds.accountId, LS_password: creds.password, LS_keepalive_millis: "5000" },
      this.abort.signal,
    );
    if (!res.ok || !res.body) throw new StreamClosed(`create_session failed (HTTP ${res.status})`);
    const lines = readLines(res.body as unknown as ReadableStream<Uint8Array>);

    const header = await this.readHeader(lines, "create_session");
    const control = header.ControlAddress ? `https://${header.ControlAddress}` : creds.endpoint.replace(/\/+$/, "");
    this.keepaliveMs = Number(header.KeepaliveMillis) || 5000;
    this.session = { id: header.SessionId ?? "", control, accountId: creds.accountId };
    if (!this.session.id) throw new StreamClosed("create_session returned no SessionId");
    this.backoff.reset();
    this.status.up();
    this.armWatchdog();

    // (Re)subscribe every table on the new session.
    for (const [id, table] of this.tables) await this.addTable(id, table);

    let reader = lines;
    for (;;) {
      const outcome = await this.consume(reader);
      if (outcome !== "loop" || !this.running) return;
      // LOOP: the server ended this HTTP response; rebind to the same session.
      const bind = await this.post(`${this.session.control}/lightstreamer/bind_session.txt`, { LS_session: this.session.id }, this.abort.signal);
      if (!bind.ok || !bind.body) throw new StreamClosed(`bind_session failed (HTTP ${bind.status})`);
      reader = readLines(bind.body as unknown as ReadableStream<Uint8Array>);
      await this.readHeader(reader, "bind_session");
      this.armWatchdog();
    }
  }

  private async readHeader(lines: AsyncGenerator<string>, what: string): Promise<Record<string, string>> {
    const first = await lines.next();
    if (first.done) throw new StreamClosed(`${what}: empty response`);
    if (first.value !== "OK") {
      const rest: string[] = [];
      for await (const l of lines) {
        rest.push(l);
        if (rest.length > 5) break;
      }
      const msg = [first.value, ...rest].filter(Boolean).join(" ").trim();
      // Code 1 = user/password check failed (expired CST/XST).
      const auth = first.value === "ERROR" && (rest[0] === "1" || /auth|password|user/i.test(msg));
      throw new StreamClosed(`${what} rejected: ${msg}`, false, auth);
    }
    // Read with next(), not `for await … break`: breaking out of for-await would end the
    // generator and close the streaming HTTP response (and with it the session).
    const header: Record<string, string> = {};
    for (;;) {
      const r = await lines.next();
      if (r.done) throw new StreamClosed(`${what}: stream ended inside the header`);
      if (r.value === "") break;
      const i = r.value.indexOf(":");
      if (i > 0) header[r.value.slice(0, i)] = r.value.slice(i + 1);
    }
    return header;
  }

  /** Reads updates until the stream ends. Returns "loop" when a rebind is required. */
  private async consume(lines: AsyncGenerator<string>): Promise<"loop"> {
    for await (const line of lines) {
      this.status.touch();
      this.armWatchdog();
      if (line === "" || line === "PROBE" || line.startsWith("Preamble")) continue;
      if (line.startsWith("LOOP")) return "loop";
      if (line.startsWith("END")) throw new StreamClosed(`server closed the session (${line})`);
      if (line.startsWith("SYNC ERROR")) throw new StreamClosed("SYNC ERROR");
      if (line.startsWith("ERROR")) throw new StreamClosed(`stream error: ${line}`);
      this.onUpdateLine(line);
    }
    throw new StreamClosed("stream ended");
  }

  private onUpdateLine(line: string): void {
    const comma = line.indexOf(",");
    if (comma <= 0) return;
    const tableId = Number(line.slice(0, comma));
    const table = this.tables.get(tableId);
    if (!table) return;
    const tokens = line.slice(comma + 1).split("|");
    const item = Number(tokens[0]) - 1;
    if (!Number.isInteger(item) || item < 0) return;
    const prev = table.state.get(item) ?? {};
    const values: Record<string, string | null> = {};
    table.fields.forEach((field, i) => {
      values[field] = decodeValue(tokens[i + 1], prev[field] ?? null);
    });
    table.state.set(item, values);
    try {
      table.onUpdate(item, values);
    } catch (err) {
      logger.warn("IG stream listener threw", { err: String(err) });
    }
  }

  // --- control requests ---------------------------------------------------------

  private async addTable(id: number, table: Table): Promise<void> {
    if (!this.session || table.live) return;
    table.state.clear();
    try {
      await this.control({
        LS_op: "add",
        LS_table: String(id),
        LS_mode: table.mode,
        ...(table.adapter ? { LS_data_adapter: table.adapter } : {}),
        LS_id: table.items(this.session.accountId).join(" "),
        LS_schema: table.fields.join(" "),
      });
      table.live = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("IG stream subscription failed", { stream: this.name, err: msg });
      table.onError?.(msg);
    }
  }

  private async control(params: Record<string, string>): Promise<void> {
    if (!this.session) throw new Error("no IG stream session");
    await this.controlTo(this.session, params);
  }

  private async controlTo(session: { id: string; control: string }, params: Record<string, string>): Promise<void> {
    const res = await this.post(`${session.control}/lightstreamer/control.txt`, { ...params, LS_session: session.id }, AbortSignal.timeout(10_000));
    const text = (await res.text()).trim();
    if (!res.ok || !text.startsWith("OK")) throw new Error(`control ${params.LS_op} failed: ${text.replace(/\s+/g, " ").slice(0, 200) || `HTTP ${res.status}`}`);
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    // The server sends PROBE lines at least every keepalive interval.
    this.watchdog = setTimeout(() => {
      this.status.error = "no data from IG stream (keepalive timeout)";
      this.abort?.abort();
    }, Math.max(30_000, this.keepaliveMs * 4));
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }
}

export function decodeValue(raw: string | undefined, previous: string | null): string | null {
  if (raw === undefined || raw === "") return previous;
  if (raw === "#") return null;
  if (raw === "$") return "";
  if (raw[0] === "#" || raw[0] === "$") return raw.slice(1);
  return raw;
}

async function* readLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) yield buf.replace(/\r$/, "");
}
