import { bybitPlatform } from "./bybit/index.js";
import { igPlatform } from "./ig/index.js";
import type { PlatformDefinition } from "./types.js";

/** Add new platforms here. Everything else (UI forms, MCP tools) is driven by the definitions. */
const PLATFORMS: PlatformDefinition[] = [bybitPlatform, igPlatform];

const byId = new Map(PLATFORMS.map((p) => [p.id, p]));

export function listPlatforms(): PlatformDefinition[] {
  return PLATFORMS;
}

export function getPlatform(id: string): PlatformDefinition | undefined {
  return byId.get(id);
}
