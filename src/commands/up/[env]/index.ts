import { z } from "zod";
import type { Context } from "@clfly/core";
import { doUp, loadWorkspace } from "../../../ops.js";

export const meta = {
  description: "Start an environment (optionally as an isolated fork)",
};

export const args = z.object({
  fork: z
    .string()
    .optional()
    .describe("Start an isolated fork of this environment"),
  isolate: z
    .string()
    .optional()
    .describe(
      "Comma-separated services to run as container-isolated for this fork",
    ),
  hooks: z
    .boolean()
    .default(true)
    .describe("Run lifecycle hooks (use --no-hooks to skip)"),
  rollback: z
    .boolean()
    .default(true)
    .describe(
      "Roll back partial resources when compose up fails (use --no-rollback to leave them)",
    ),
});

export default async function (
  opts: z.infer<typeof args> & { env: string },
  ctx: Context,
) {
  const { root, config } = loadWorkspace(ctx.cwd);
  await doUp(root, config, opts.env, {
    fork: opts.fork,
    isolate: opts.isolate,
    hooks: opts.hooks,
    noRollback: !opts.rollback,
  });
}
