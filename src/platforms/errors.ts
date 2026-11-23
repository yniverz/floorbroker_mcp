export type PlatformErrorCode =
  | "auth_failed"
  | "permission_denied"
  | "rate_limited"
  | "invalid_request"
  | "not_found"
  | "unsupported"
  | "rejected"
  | "insufficient_funds"
  | "market_closed"
  | "network"
  | "platform_error";

/** An error an agent can act on. `message` should say what went wrong and, ideally, what to do. */
export class PlatformError extends Error {
  constructor(
    public readonly code: PlatformErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PlatformError";
  }
}

export function unsupported(what: string, platform: string): PlatformError {
  return new PlatformError("unsupported", `${what} is not supported on ${platform}.`);
}
