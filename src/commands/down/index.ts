export const meta = {
  description:
    "Stop an instance (drops volumes unless the environment is persistent)",
};

export default async function () {
  throw new Error(
    "Missing <env>. Usage: forkspace down <env> [options]. Run with --help for details.",
  );
}
