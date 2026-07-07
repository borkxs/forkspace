import { nsFor } from "./ns";
import { instanceKey, projectName, type State } from "./state";

/** Max fork name length; matches nsFor truncation. */
export const FORK_NAME_MAX_LENGTH = 32;

/** Allowed raw fork name characters (no path separators). */
export const FORK_NAME_RE = /^[A-Za-z0-9._-]+$/;

export function validateForkName(fork: string): void {
  if (fork.length === 0) {
    throw new Error("Fork name must not be empty.");
  }
  if (fork.length > FORK_NAME_MAX_LENGTH) {
    throw new Error(
      `Fork name "${fork}" is too long (${fork.length} chars). ` +
        `Maximum length is ${FORK_NAME_MAX_LENGTH}.`
    );
  }
  if (!FORK_NAME_RE.test(fork)) {
    throw new Error(
      `Fork name "${fork}" contains invalid characters. ` +
        `Allowed: letters, digits, dot (.), underscore (_), hyphen (-). ` +
        `Path separators are not allowed.`
    );
  }
  if (nsFor(fork) === "") {
    throw new Error(
      `Fork name "${fork}" normalizes to an empty namespace token. ` +
        `Use a name that contains at least one letter or digit.`
    );
  }
}

export function assertNoForkCollisions(opts: {
  fork: string;
  envName: string;
  workspace: string;
  state: State;
  baselineNs?: string;
}): void {
  const { fork, envName, workspace, state, baselineNs } = opts;
  const newKey = instanceKey(envName, fork);
  const newProject = projectName(workspace, envName, fork);
  const newNs = nsFor(fork);
  const baselineToken =
    baselineNs ?? state.instances[envName]?.ns ?? "";

  if (newNs && baselineToken && newNs === baselineToken) {
    throw new Error(
      `Fork "${fork}" maps to namespace token "${newNs}", which is reserved for the ` +
        `baseline instance. Choose a different fork name.`
    );
  }

  for (const inst of Object.values(state.instances)) {
    if (inst.key === newKey) continue;

    if (inst.project === newProject) {
      throw new Error(
        `Fork "${fork}" maps to compose project "${newProject}", which is already used by ` +
          `instance ${inst.key} (fork "${inst.fork}"). Choose a different fork name.`
      );
    }

    if (newNs && inst.ns && inst.ns === newNs) {
      throw new Error(
        `Fork "${fork}" maps to namespace token "${newNs}", which is already used by ` +
          `instance ${inst.key} (fork "${inst.fork}"). Choose a different fork name.`
      );
    }
  }
}
