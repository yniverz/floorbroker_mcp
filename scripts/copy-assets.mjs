import { cpSync, mkdirSync } from "node:fs";
mkdirSync("dist/web/public", { recursive: true });
cpSync("src/web/public", "dist/web/public", { recursive: true });
