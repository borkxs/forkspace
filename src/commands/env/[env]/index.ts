import { z } from "zod";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Context } from "@clfly/core";
import { instanceKey } from "../../../state.js";
import { loadWorkspace } from "../../../ops.js";

export const meta = {
  description:
    "Print the env file for an instance (eval-able: `source <(forkspace env test --fork a)`)",
};

export const args = z.object({
  fork: z.string().optional().describe("Fork name"),
});

export default async function (
  opts: z.infer<typeof args> & { env: string },
  ctx: Context,
) {
  const { root, state } = loadWorkspace(ctx.cwd);
  const key = instanceKey(opts.env, opts.fork ?? null);
  const inst = state.instances[key];
  if (!inst) throw new Error(`No instance ${key}. Run \`forkspace up\` first.`);
  const file = path.join(root, inst.envFile);
  if (!existsSync(file)) throw new Error(`Env file missing: ${inst.envFile}`);
  ctx.stdout.write(readFileSync(file, "utf8"));
}
