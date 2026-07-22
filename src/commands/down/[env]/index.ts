import { z } from "zod";
import type { Context } from "@clfly/core";
import { doDown, loadWorkspace } from "../../../ops.js";

export const meta = {
  description:
    "Stop an instance (drops volumes unless the environment is persistent)",
};

export const args = z.object({
  fork: z.string().optional().describe("Fork name"),
  "keep-volumes": z
    .boolean()
    .optional()
    .describe("Keep volumes even for non-persistent environments"),
  force: z
    .boolean()
    .optional()
    .describe("Skip forkDestroy and clean up state anyway"),
});

export default async function (
  opts: z.infer<typeof args> & { env: string },
  ctx: Context,
) {
  const { root, config } = loadWorkspace(ctx.cwd);
  await doDown(root, config, opts.env, {
    fork: opts.fork,
    keepVolumes: opts["keep-volumes"],
    force: opts.force,
  });
}
