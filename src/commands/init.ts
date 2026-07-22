import { existsSync, writeFileSync } from "node:fs";
import type { Context } from "@clfly/core";
import { CONFIG_FILENAME } from "../config.js";
import { STARTER_CONFIG } from "../starter-config.js";

export const meta = {
  description: "Write a starter forkspace.yml in the current directory",
};

export default async function (_opts: Record<string, never>, ctx: Context) {
  const dest = `${ctx.cwd}/${CONFIG_FILENAME}`;
  if (existsSync(dest)) {
    throw new Error(`${CONFIG_FILENAME} already exists here.`);
  }
  writeFileSync(dest, STARTER_CONFIG);
  console.log(`Wrote ${CONFIG_FILENAME}. Edit it, then \`forkspace check\`.`);
}
