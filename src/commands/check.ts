import type { Context } from "@clfly/core";
import { checkConfig } from "../config.js";
import { loadWorkspace } from "../ops.js";

export const meta = {
  description:
    "Validate forkspace.yml against the workspace (compose files, services, port conflicts)",
};

export default async function (_opts: Record<string, never>, ctx: Context) {
  const { root, config } = loadWorkspace(ctx.cwd);
  const { errors, warnings } = checkConfig(config, root);
  for (const w of warnings) console.warn(`⚠ ${w}`);
  if (errors.length === 0) {
    const suffix = warnings.length
      ? ` (${warnings.length} warning${warnings.length === 1 ? "" : "s"})`
      : "";
    console.log(`✓ config OK${suffix}`);
    return { ok: true, warnings };
  }
  for (const p of errors) console.error(`✗ ${p}`);
  process.exitCode = 1;
  return { ok: false, errors, warnings };
}
