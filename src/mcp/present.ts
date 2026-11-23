/** Fields holding epoch-millisecond timestamps that are rendered as ISO 8601 for agents. */
const TIME_FIELDS = new Set([
  "time",
  "createdAt",
  "updatedAt",
  "openedAt",
  "closedAt",
  "expiry",
  "nextFundingTime",
  "resetsAt",
  "from",
  "to",
]);

function toSnake(key: string): string {
  return key.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
}

/**
 * Converts adapter output into what agents see: snake_case keys, ISO timestamps,
 * and no null/undefined fields (saves tokens; absent means "not reported").
 */
export function present(value: unknown, key?: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number" && key && TIME_FIELDS.has(key)) {
    return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : undefined;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (Array.isArray(value)) return value.map((v) => present(v)).filter((v) => v !== undefined);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const p = present(v, k);
      if (p === undefined) continue;
      if (typeof p === "object" && !Array.isArray(p) && Object.keys(p as object).length === 0) continue;
      out[toSnake(k)] = p;
    }
    return out;
  }
  return value;
}

export function iso(ms: number | null | undefined): string | undefined {
  return ms ? new Date(ms).toISOString() : undefined;
}

export function parseTime(value: string | undefined, field: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const asNum = Number(value);
  const ms = Number.isFinite(asNum) && /^\d+$/.test(value) ? (asNum < 1e12 ? asNum * 1000 : asNum) : Date.parse(value);
  if (!Number.isFinite(ms)) throw new Error(`${field} must be an ISO 8601 timestamp (e.g. 2026-01-31T12:00:00Z).`);
  return ms;
}
