#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { createCli } from "@clfly/core";

const cli = createCli({
  name: "forkspace",
  commandsDir: new URL("./commands", import.meta.url),
  packageJsonPath: fileURLToPath(new URL("../package.json", import.meta.url)),
});

try {
  const result = await cli.run(process.argv.slice(2));
  process.exitCode ??= result.exitCode;
} catch (err: unknown) {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
