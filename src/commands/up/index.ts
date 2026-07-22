export const meta = {
  description: "Start an environment (optionally as an isolated fork)",
};

export default async function () {
  throw new Error(
    "Missing <env>. Usage: forkspace up <env> [options]. Run with --help for details.",
  );
}
