import { z } from "zod";
import type { Context } from "@clfly/core";
import { doPrune, loadWorkspace } from "../ops.js";

export const meta = {
  description:
    "Remove docker compose projects and workspace artifacts not tracked in state",
};

export const args = z.object({
  "dry-run": z
    .boolean()
    .optional()
    .describe("Print what would be removed without making changes"),
  force: z
    .boolean()
    .optional()
    .describe(
      "Drop volumes for stranded projects even when the environment is unknown",
    ),
});

export default async function (opts: z.infer<typeof args>, ctx: Context) {
  const { root, config } = loadWorkspace(ctx.cwd);
  doPrune(root, config, {
    dryRun: opts["dry-run"],
    force: opts.force,
  });
}
