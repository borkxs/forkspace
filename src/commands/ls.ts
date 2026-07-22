import { z } from "zod";
import type { Context } from "@clfly/core";
import {
  listInstances,
  loadInstanceEnv,
  loadWorkspace,
  printOrphanReports,
} from "../ops.js";
import { hasListNamespacesHook, orphanReports } from "../orphans.js";

export const meta = {
  description: "List instances",
};

export const args = z.object({
  ps: z
    .boolean()
    .optional()
    .describe("Also query docker for container status"),
  orphans: z
    .boolean()
    .optional()
    .describe(
      "Diff namespace-isolated forks against hooks.listNamespaces (requires baseline up)",
    ),
});

export default async function (opts: z.infer<typeof args>, ctx: Context) {
  const { root, config, state } = loadWorkspace(ctx.cwd);

  if (opts.orphans) {
    if (!hasListNamespacesHook(config)) {
      console.log(
        "No listNamespaces hook configured. Add hooks.listNamespaces to an environment " +
          "in forkspace.yml to enable orphan detection.",
      );
    } else {
      printOrphanReports(
        orphanReports(config, state, root, (envFileRel) =>
          loadInstanceEnv(root, envFileRel),
        ),
      );
    }
    if (Object.values(state.instances).length > 0) console.log("");
  }

  if (!opts.orphans || Object.values(state.instances).length > 0) {
    listInstances(root, state, !!opts.ps);
  }
}
