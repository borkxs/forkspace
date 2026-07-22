export const meta = {
  description:
    "Print the env file for an instance (eval-able: `source <(forkspace env test --fork a)`)",
};

export default async function () {
  throw new Error(
    "Missing <env>. Usage: forkspace env <env> [options]. Run with --help for details.",
  );
}
