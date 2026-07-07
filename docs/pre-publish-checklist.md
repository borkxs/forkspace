# Pre-publish audit and checklist (toward v1 / first npm release)

Audit date: 2026-07-07, at v0.2.0 (`main` @ b5a9ce7). This is the third audit pass;
it builds on [audit-v0.2.md](audit-v0.2.md) (F1–F5) and
[stress-test-findings.md](stress-test-findings.md) (findings 1–7), re-verifies which
of those are actually fixed on `main`, and re-runs the strategy end-to-end against a
real Docker daemon (Docker 29, compose v5.3, Linux).

## Verdict on the strategy

The core thesis — forkspace as *naming authority* over ports, slots, namespace
tokens, and env files, with all engine work delegated to hooks — held up under
end-to-end testing with zero code changes needed to complete the test matrix. Every
layer promised by the README was exercised and worked:

| Tested | Result |
|---|---|
| `dev` + `test` baselines coexisting (port math) | ✓ mysql 3306 / 3406 side by side |
| Namespace forks (`up test --fork agent-a/b`) | ✓ one MySQL container, three databases; writes in one fork invisible to others (verified via direct SQL) |
| Clone-from-baseline hooks (`FORKSPACE_BASELINE_*`) | ✓ dump/restore from exported baseline addresses, no hardcoding |
| `--isolate mysql` container fork | ✓ fresh container on slot port 3436, correct `DATABASE_URL`, baseline vars present |
| Orphan/ghost detection (`ls --orphans`) | ✓ planted `stray_db` reported as orphan, manually dropped fork db as ghost |
| Teardown guardrails | ✓ baseline `down` refused with live forks; `forkDestroy` ran per fork; zero container/network residue after full teardown |
| Concurrency (6 parallel `up --fork`) | ✓ unique slots 2–7, consistent `state.json`, no lock artifacts |
| Fork-name validation | ✓ `feature/x`, `@@@`, 40-char names rejected pre-side-effects; 32-digit truncation collision (`f_111…` prefix) refused with the conflicting instance named |
| Hook-failure rollback | ✓ failing `forkCreate` unregisters the fork (`rolled back: forkDestroy, env file, state`) |
| Persistent vs ephemeral volumes | ✓ `down` keeps/drops volumes per `persistent` (but see B7) |
| Packaging | ✓ `npm pack` tarball installs in a scratch project; `node_modules/.bin/forkspace --version` works |

Fixed since the v0.2 audit and confirmed on `main`: F1 (fork-name validation),
F2 (state lock + atomic writes), the hook-rollback half of F3, and stress-test
findings 1, 2, 4, 5 (`baselineNs`, `{nsdash}`, `FORKSPACE_INVOKE_DIR`,
`FORKSPACE_BASELINE_*`).

Baseline health at audit time: `npm run typecheck` clean, `npm test` 58/58,
`npm run build` clean, `npm view forkspace` → 404 (the name is free on npm).

---

## Checklist

### Blockers — must fix before publishing

- [ ] **B1 (bug, high): env files are not shell-safe.** `renderEnvFile` (`src/env.ts`)
  writes `KEY=value` with no quoting or escaping, while the `env` command help and
  README explicitly advertise `source <(forkspace env test --fork a)`. Reproduced:
  an export value containing a space, `$`, `;`, `&`, or backticks breaks sourcing
  mid-file — and backticks/`$(…)` in a value would *execute* on source. Even the
  realistic case `?opts=a&b=c` in a DB URL kills the contract. Fix: single-quote
  values (with `'\''` escaping) when writing, and keep `envToRecord` parsing in
  sync so hooks see identical values. Applies to `FORKSPACE_INVOKE_DIR` too
  (paths with spaces). Add unit tests with hostile values.
- [ ] **B2: no `LICENSE` file.** `package.json` says MIT but the repo and the npm
  tarball contain no license text. Publishing without it is a legal gap and npm
  flags it. Add MIT `LICENSE` and include it in `files`.
- [ ] **B3: no CI.** Nothing runs typecheck/tests on push or PR. Add
  `.github/workflows/ci.yml` (Node 20/22 matrix: `npm ci`, typecheck, test,
  build). Unit tests need no Docker.
- [ ] **B4: version drift.** `VERSION = "0.2.0"` is hardcoded in `src/cli.ts`,
  duplicating `package.json`. Read it from `package.json` at runtime (path works
  from both `src/` and `dist/`) so `--version` can't lie after a bump.
- [ ] **B5: no recovery for stranded compose projects (`prune`).** Verified: if
  `state.json` is lost (or an early crash strands a project), the containers keep
  running and every command says "No instance … Nothing to do" — the only recovery
  is raw `docker` commands. Also verified the asymmetry: a *hook* failure rolls the
  instance back, but a *compose* failure mid-`up` leaves the instance registered
  with no env file (recoverable only by knowing to run `down`). Add
  `forkspace prune [--dry-run]` that diffs `docker compose ls` projects with the
  `fs-<workspace>-` prefix against state (the docker-project inverse of
  `ls --orphans`), and either roll back compose failures like hook failures or
  print the `down` recovery hint on failure.
- [ ] **B6: compose ≥ 2.24 is assumed, never checked.** The `!override` port-remap
  tag silently changes meaning on older compose (ports would *append*, i.e. two
  instances fighting over the base port — the exact corruption forkspace exists to
  prevent). Add a version probe (`docker compose version`) to `check` and/or fail
  fast in `composeUp`, with a clear "compose >= 2.24 required" error.
- [ ] **B7 (docs): `persistent: true` does not survive `down`→`up` with anonymous
  volumes.** Verified: a mysql service with no named volume lost its data across
  `down`/`up` of a persistent env, because compose creates a fresh anonymous volume
  for the new container. The README's "volumes survive `down`" claim is only true
  for named volumes. Document the requirement; optionally have `check` warn when a
  `persistent` environment's compose services declare no named volume for their
  data paths.

### Should fix — high value, not strictly blocking

- [ ] **S1: `--json` output** for `ls` / `env` / `up` / `down` (audit F5, task
  prompt 4 in [audit-v0.2.md](audit-v0.2.md)). The primary consumers are agents;
  today they must scrape padded tables. `ls --ps` currently prints raw docker JSON
  lines indented under a human row — worst of both formats.
- [ ] **S2: freeze the teardown contract at `up` time.** `doDown` reads
  `hooks.forkDestroy` and `persistent` from the *current* `forkspace.yml`, so
  editing config while instances run retroactively changes teardown semantics.
  Record what matters on the `InstanceRecord` at `up`, prefer it at `down`
  (audit F4, third bullet).
- [ ] **S3: state schema version field.** `state.json` has no version marker; the
  first post-release schema change will face old files with no way to detect or
  migrate them. Write `{"version": 1, "instances": …}` before the format is public.
- [ ] **S4: publish metadata + guard.** `package.json` lacks `repository`,
  `keywords`, `author`, `bugs`, `homepage`; add a `prepublishOnly` script
  (`npm run typecheck && npm test && npm run build`) so a stale or missing `dist/`
  can't be published. Consider `publishConfig.access`.
- [ ] **S5: README install section is source-only.** It documents `npm install`
  + `npm link` from a checkout; for the release it should lead with
  `npm install -g forkspace` and state the runtime prerequisites (Node ≥ 18,
  docker compose ≥ 2.24).

### Nice to have — defer past first release

- [ ] N1: per-service `listNamespaces` for per-engine orphan drift
  (stress-test finding 6).
- [ ] N2: workspace identity is the `workspace:` string only — two directories with
  the same workspace name map to the same compose project names and will fight.
  Consider mixing a root-path hash into the project name, or at least document it.
- [ ] N3: `isPortFree` probes `127.0.0.1` only. On Linux this does catch docker's
  `0.0.0.0` publishes (verified against a live container), but the cross-platform
  claim is untested; consider probing `0.0.0.0` (audit F4, first bullet).
- [ ] N4: hook timeout. Hooks run via `spawnSync` with no timeout; a hung
  `forkCreate` hangs `up` (and holds no lock, so it's benign but silent).
- [ ] N5: publish provenance / `npm publish --provenance` from CI once B3 lands.

### Suggested order

B2/B3/B4/S4 are one hygiene PR (audit task prompt 5 covers most of it). B1 is the
only *code contract* bug and should land with its own tests. B5 and B6 harden the
failure paths the stress test flagged. B7/S5 are docs. S1–S3 shape the public
contract and are cheapest to do before the format is frozen by a release — after
v1, changing `state.json` or the env-file format is a breaking change.

## Not retested here

Cross-platform behavior (macOS/Windows: lockfile PID probes, `0.0.0.0` binds),
compose < 2.24 behavior (no old compose available; B6 is inferred from the
`!override` contract), large-data clone performance, and multi-machine/shared
state (out of scope per README).
