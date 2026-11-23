/**
 * Single source of truth for the CSP. The UI needs no JavaScript at all.
 * The OAuth authorize endpoints extend form-action with the redirect URI origin,
 * because browsers enforce form-action across the redirect that completes the flow.
 */
export const CSP_DIRECTIVES: Record<string, string[]> = {
  "default-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'self'"],
  "frame-ancestors": ["'none'"],
  "style-src": ["'self'"],
  "img-src": ["'self'", "data:"],
  "font-src": ["'self'"],
  "connect-src": ["'self'"],
  "script-src": ["'none'"],
  "object-src": ["'none'"],
};

export function cspHeaderValue(extraFormAction: string[] = [], upgradeInsecure = false): string {
  const directives = { ...CSP_DIRECTIVES, "form-action": ["'self'", ...extraFormAction] };
  const parts = Object.entries(directives).map(([name, values]) => `${name} ${values.join(" ")}`);
  if (upgradeInsecure) parts.push("upgrade-insecure-requests");
  return parts.join("; ");
}
