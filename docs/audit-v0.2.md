# forkspace v0.2.0 — Audit Findings & Task Prompts

Audit date: 2026-07-06. Scope: full source read (`src/*.ts`, `test/forkspace.test.ts`,
config/docs), static checks, unit tests, and empirical probing of edge cases via `tsx`.

Baseline health at audit time: `npm run typecheck` clean, `npm test` 36/36 passing,
no open issues or PRs. Modules are small and well-factored; docs are strong. The
findings below are ordered by severity, and each has a ready-to-use agent prompt in
the [Task prompts](#task-prompts) section.

---

## Findings

### F1 — Fork names are never validated; collisions corrupt live instances (bug, high)

`doUp` in `src/cli.ts` uses `--fork` verbatim. Three distinct derived identities are
computed from it, and none are checked for collisions or degenerate values:

| Derivation | Where | Failure verified |
|---|---|---|
| compose project | `projectName()` in `src/state.ts` | `agent.a` and `agent-a` both map to `fs-acme-test-agent-a` — different state keys, same docker project. Second `up` remaps the first fork's container ports; `down` of one destroys the other's containers. |
| namespace token | `nsFor()` in `src/ns.ts` | `nsFor("@@@")` → `""`, the **baseline** token: the fork silently shares the baseline database. Long names truncated at 32 chars collide (`agent-xxx…x-1` ≡ `agent-xxx…x-2`). |
| env file path | `envFileName()` in `src/env.ts` | `--fork feature/x` → `.env.forkspace.test.feature/x`; `writeFileSync` throws ENOENT **after containers are already started**. |

### F2 — No concurrency safety on `state.json` (bug, high)

The tool's core promise is parallel agents, but `loadState` → mutate → `saveState`
(`src/state.ts`) is an unlocked read-modify-write executed once per CLI invocation
(`ctx()` in `src/cli.ts`). Two concurrent `up` calls can both read the same state,
allocate the same slot (namespace-only forks probe zero host ports, so
`allocateSlot` in `src/ports.ts` provides no protection), and the last writer erases
the other's instance record — leaving a running, untracked fork.

### F3 — No rollback on partial `up` failure (bug, medium)

In `doUp`, compose runs execute per compose-file group in a loop; state is saved
only after **all** `composeUp` calls succeed. If a later group fails, earlier
groups' containers keep running with no state record. `down` reports "No instance …
Nothing to do", and the containers plus the `.forkspace/<project>/` override dir are
stranded. There is also no reconcile/prune command to recover (the inverse of
`ls --orphans` for docker projects rather than namespaces).

### F4 — Minor bugs

- `isPortFree` (`src/ports.ts`) probes `127.0.0.1` only; Docker publishes on
  `0.0.0.0`, so ports bound on other interfaces slip through the slot probe.
- `VERSION` is hardcoded in `src/cli.ts` and duplicates `package.json`; they will drift.
- `doDown` reads `hooks.forkDestroy` from the *current* config, not the config in
  effect at `up` time — editing `forkspace.yml` while forks are live retroactively
  changes teardown behavior.

### F5 — Gaps (not bugs)

- **No machine-readable output.** For an agent-first tool, `ls`/`up`/`env` emit only
  padded human tables; agents must scrape them.
- **No repo hygiene for publishing.** `package.json` declares MIT but there is no
  `LICENSE` file; no CI workflow runs the typecheck/test gates.
- **No end-to-end test.** Everything at or below `composeUp` is untested against a
  real daemon; unit tests cannot catch compose CLI drift (e.g. the `!override` tag
  contract, compose ≥ 2.24).

### Recommended order

1. F1 — fork-name validation (smallest fix, blocks data corruption)
2. F2 — state locking (makes the core "parallel agents" promise safe)
3. F3 — partial-up rollback + prune
4. F5 — `--json` output
5. F4/F5 — hygiene: CI, LICENSE, single-source version

---

## Task prompts

Each prompt is self-contained and can be handed to an agent as-is.

### Task 1 — Fork-name validation and collision detection

```
In the forkspace repo (TypeScript CLI, npm scripts: typecheck / test / dev), fix the
unvalidated --fork name handling in `doUp` (src/cli.ts).

Problems to fix (all empirically verified):
1. projectName() in src/state.ts maps both "." and "-" to "-", so forks "agent.a"
   and "agent-a" share compose project fs-<ws>-<env>-agent-a while having distinct
   state keys. The second `up` remaps the first fork's ports and `down` destroys the
   other's containers.
2. nsFor() in src/ns.ts returns "" for names with no [a-z0-9_] chars (e.g. "@@@"),
   which is the baseline namespace token — the fork silently shares the baseline
   database. Names longer than 32 chars truncate and can collide.
3. envFileName() in src/env.ts embeds the raw fork name, so "feature/x" produces a
   path with a directory separator and writeFileSync throws ENOENT after containers
   have already started.

Requirements:
- Validate the fork name at the top of doUp, before any side effects. Reject names
  that are empty after normalization, contain path separators or characters outside
  a safe charset (suggest: [A-Za-z0-9._-]), or exceed a sane length (32 chars is
  consistent with nsFor). Error messages must say what is allowed.
- Additionally detect derived-identity collisions against live instances in state:
  if the new fork's projectName OR nsFor token equals that of a different existing
  instance, refuse with a clear message naming the conflicting instance.
- Do not change the derivation rules for existing valid names (agent-a must still
  produce ns agent_a and project fs-<ws>-<env>-agent-a) — existing state files must
  keep working.
- Add unit tests in test/forkspace.test.ts covering: rejection of "@@@", "feature/x",
  overlong names; collision rejection of "agent.a" vs live "agent-a"; ns-token
  collision of two 40-char names sharing a 32-char prefix; acceptance of "agent-a".

Testing: npm run typecheck && npm test must pass. Also demonstrate via
`npm run dev -- up ...` in a throwaway fixture workspace (no Docker needed — the
validation error must trigger before any docker call) that the bad names are
rejected with helpful errors.
```

### Task 2 — State-file locking and atomic slot allocation

```
In the forkspace repo (TypeScript CLI for forking docker compose stacks per agent),
make concurrent CLI invocations safe.

Current behavior: every command loads .forkspace/state.json once (ctx() in
src/cli.ts), mutates it in memory, and saveState() (src/state.ts) rewrites the whole
file. Two concurrent `forkspace up test --fork a` / `--fork b` runs can both read
the same state, allocate the same slot (allocateSlot in src/ports.ts probes host
ports, but namespace-only forks probe zero ports, so it provides no protection),
and the last writer erases the other's instance record — leaving a running,
untracked fork. This defeats the tool's core purpose of supporting parallel agents.

Requirements:
- Implement a mutual-exclusion lock around the read-modify-write cycle for the
  mutating commands (up, down). Prefer a dependency-free approach: an exclusive
  lockfile (e.g. .forkspace/state.lock created with O_EXCL / mkdir) with stale-lock
  detection (PID + timestamp, steal after a timeout) and bounded retry with backoff.
  Adding a small well-maintained dependency (e.g. proper-lockfile) is acceptable if
  you justify it.
- Re-read state inside the lock before mutating, so slot allocation and the
  "instance already exists" check operate on fresh data. The lock must be held
  across: existence check → slot allocation → compose up → state write. If holding
  it across compose up is too coarse, an acceptable alternative is: reserve the
  instance record (with slot) in state under the lock first, then run compose
  outside the lock, then finalize under the lock again — pick one and document why.
- Write state atomically (write temp file + rename) instead of writeFileSync in
  place.
- Read-only commands (ls, env, check) must not take the lock.
- Add unit tests for the lock primitive (acquire, contention, stale-lock steal).
  Then demonstrate end-to-end: launch two `up` invocations of namespace-only forks
  concurrently (hooks can be stubs; no Docker required if the env has no
  container-isolated services) and show both instances end up in state.json with
  distinct slots.

Testing: npm run typecheck && npm test must pass, plus the concurrent-up
demonstration with its output shown.
```

### Task 3 — Rollback on partial `up` failure and a `prune` command

```
In the forkspace repo (TypeScript CLI orchestrating docker compose stacks), fix
stranded-resource behavior when `up` fails partway, and add a recovery command.

Current behavior (doUp in src/cli.ts): compose runs execute per compose-file group
in a loop (planComposeRuns/composeUp in src/compose.ts); state.json is written only
after ALL groups succeed. If group 2 fails, group 1's containers keep running with
no state record; `forkspace down` says "No instance … Nothing to do"; the
.forkspace/<project>/ override directory is also stranded. Hook failures after
state is saved leave the instance recorded, which is fine — the gap is compose-time
failure.

Requirements:
1. Rollback: if any composeUp call fails during `up`, tear down what was started
   (composeDown with the same project name, removing volumes for non-persistent
   environments), delete the .forkspace/<project>/ override dir and any env file
   written, and exit non-zero with an error that says rollback happened. A
   --no-rollback escape hatch may be added for debugging but is optional.
2. Prune: add `forkspace prune` which lists docker compose projects matching the
   workspace prefix (fs-<workspace>-…; use `docker compose ls --format json` or
   label filters) that have NO corresponding instance in state.json, and tears them
   down (with -v unless the matching environment is persistent; if the environment
   cannot be inferred, require --force to remove volumes). Also remove orphaned
   .forkspace/<project>/ dirs and .env.forkspace.* files with no state record.
   Support --dry-run that only prints what would be removed.
3. Keep the existing behavior for hook failures unchanged.

Testing: npm run typecheck && npm test with new unit tests for the prune
state-vs-projects diff logic (injectable, like src/orphans.ts does for namespaces).
For end-to-end proof, Docker is required: per AGENTS.md, install docker-ce in the
VM (storage driver fuse-overlayfs, features.containerd-snapshotter: false in
/etc/docker/daemon.json, iptables-legacy, run sudo dockerd, chmod 666
/var/run/docker.sock). Then in a fixture workspace with two compose files, make the
second group fail (e.g. invalid image), run `up`, and show group 1's containers are
rolled back; separately create a stranded project and show `prune --dry-run` and
`prune` handle it.
```

### Task 4 — Machine-readable `--json` output

```
In the forkspace repo (TypeScript CLI whose primary consumers are coding agents),
add JSON output modes.

Currently ls/up/env print only padded human-readable text (src/cli.ts), which
agents must scrape.

Requirements:
- `forkspace ls --json`: emit a JSON array of instance records — key, env, fork,
  slot, project, ns, backing, ports (object), services, envFile, createdAt. With
  --ps also include container status per instance (composePs in src/compose.ts
  already returns docker's JSON; parse it rather than nesting a string). With
  --orphans include the orphan reports as structured data ({env, orphans, ghosts,
  skip}).
- `forkspace env <env> [--fork] --json`: emit the env file contents as a flat
  string-to-string JSON object (envToRecord in src/env.ts already parses the file).
- `forkspace up/down ... --json`: emit a single result object on success (the
  instance record for up; {key, removed: true} for down). Human log lines must not
  pollute stdout in JSON mode — route them to stderr or suppress them so stdout is
  exactly one JSON document.
- Errors in JSON mode should still exit non-zero; keep the human error format on
  stderr.
- JSON shape is a contract: document it in README.md and keep field names identical
  to the InstanceRecord type in src/state.ts.
- Add unit tests for any new pure serialization helpers, and end-to-end checks by
  running `npm run dev -- ls --json` etc. in a fixture workspace and piping through
  `jq` (or JSON.parse) to prove stdout is valid JSON. No Docker needed except for
  --ps (skip --ps e2e if no daemon; unit-test its parsing instead).

Testing: npm run typecheck && npm test, plus the jq/JSON.parse demonstrations.
```

### Task 5 — Repo hygiene: CI, LICENSE, single-source version, minor fixes

```
In the forkspace repo (TypeScript CLI, npm scripts typecheck/test/build), do a
hygiene pass:

1. Add .github/workflows/ci.yml running on push and pull_request: checkout,
   setup-node (Node 20 and 22 matrix), npm ci, npm run typecheck, npm test,
   npm run build. No Docker in CI — unit tests don't need it.
2. Add a LICENSE file (MIT, matching the license field in package.json; copyright
   holder: the repo owner).
3. Single-source the version: src/cli.ts hardcodes VERSION = "0.2.0" duplicating
   package.json. Read the version from package.json at runtime instead (note the
   published layout: bin is dist/cli.js and package.json sits one level above dist;
   in dev, src/cli.ts sits under src/. Resolve the path so BOTH work — e.g. try
   ../package.json relative to the module file. Avoid JSON import assertions if
   they complicate the tsconfig; readFileSync + JSON.parse is fine).
4. Fix isPortFree in src/ports.ts to catch ports bound on any interface, not just
   127.0.0.1: probe with host "0.0.0.0" (and keep behavior correct on machines
   where that maps oddly — binding to 0.0.0.0 conflicts with any interface-specific
   bind, which is what docker's default publish uses).
5. Record hooks used at up time: doDown in src/cli.ts reads hooks.forkDestroy from
   the current config; instead store the forkDestroy command string on the
   InstanceRecord (src/state.ts) at up time and prefer it at down time, falling
   back to config for records created by older versions.

Testing: npm run typecheck && npm test (extend tests for the version lookup, the
port probe, and the recorded-hook fallback). Verify `npm run build && node
dist/cli.js --version` prints the package.json version, and `npm run dev --
--version` does too. Validate the workflow YAML (e.g. with a YAML parse) since CI
can't be executed locally.
```
