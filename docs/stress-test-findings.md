# Stress-test findings and proposed fixes (v0.2)

Findings from an end-to-end stress test of the v0.2 CLI against a real
three-engine stack. Each finding was reproduced, not theorized; each fix is
scoped to the source files it touches. None of the fixes require engine-aware
code — they are all naming/addressing features, consistent with the boundary
rule (forkspace owns names, addresses, and lifecycle; repos own engine calls).

## Test setup

- Workspace with one repo, one compose file: **mysql:8.0 + redis:7 + minio**,
  all `isolation: namespace` — deliberately non-SQL-heavy to test whether the
  `{ns}` contract is engine-neutral.
- Git repo with divergent migration branches: `main` (001, 002),
  `wip-billing` (adds 003_add_billing), `review-x` (adds a conflicting
  003_add_reviews).
- Hooks implementing **clone-from-baseline**: `forkCreate` runs
  `mysqldump main | mysql $FORKSPACE_NS`, then `seed` applies whatever
  migrations the checkout adds on top. Redis isolation by key prefix
  (`{ns_}`), minio by bucket per fork.

What held up (no fixes needed): one `{ns}` token drove three isolation
mechanisms (database, key prefix, bucket); divergent schema histories
coexisted in one MySQL container with the baseline untouched; namespace fork
up = ~0.35s including clone+migrate; 4 concurrent `--no-hooks` forks = 0.13s
with unique slots and no lock races; orphan/ghost detection and all teardown
guardrails fired correctly.

---

## Finding 1: baseline namespace is `""` and poisons every export

**Severity: high (fix first). Touches: `config.ts`, `ns.ts`, `plan.ts`.**

The baseline instance has `ns=""`, so every `{ns}`-templated export renders
broken/dangling:

```
DATABASE_URL=mysql://root:root@127.0.0.1:3500/
DB_NAME=
S3_BUCKET=app-
REDIS_PREFIX=
```

Every hook and every consuming app must independently reinvent the same
default (`${FORKSPACE_NS:-main}`). Forgetting it in any one place produces
confusing engine errors, not forkspace errors.

**Fix:** add an optional per-environment `baselineNs` (e.g. `baselineNs: main`)
to `EnvironmentSchema`. `planInstance` uses it as the ns for slot 0 (fork ns
minting unchanged; `nsFor` still returns `""` only when both fork and
`baselineNs` are absent, preserving current behavior). `FORKSPACE_NS` and all
templates then render correctly for the baseline, and `assertNoForkCollisions`
must also reject forks whose token collides with `baselineNs`.

Rejected alternative: template default syntax (`{ns:-main}`) — pushes the
special case into every export string instead of stating it once.

## Finding 2: the ns token grammar is SQL-shaped; other engines need other grammars

**Severity: high. Touches: `env.ts` (template vars), `config.ts` (check warning), README.**

The token grammar `[a-z0-9_]+` is valid for MySQL/Postgres identifiers but
**invalid for S3/GCS bucket names** (underscores are forbidden). Observed:

- `mc mb app-wip_billing` → `Bucket name contains invalid characters`
- after the hook worked around it with `tr '_' '-'`, the exported
  `S3_BUCKET=app-wip_billing` no longer matched the real bucket
  (`app-wip-billing`) — the env file contract was lying.

The same problem applies to any dashed-identifier system (DNS labels,
container names, most cloud resource names).

**Fix:** mint a dashed variant of the token alongside the existing forms.
`renderEnvFile` already exposes `ns`, `_ns`, `ns_`; add `ns-` equivalents:
`{nsdash}` (`wip-billing`), plus prefixed/suffixed forms if wanted. Both
variants derive from the same fork name, so identity stays 1:1; hooks receive
both via the env file (e.g. a generated `FORKSPACE_NS_DASH`). Extend the
`checkConfig` warning for namespace services to accept either form.

## Finding 3: a failed `forkCreate` leaves a half-created fork registered as live

**Severity: high for CI. Touches: `cli.ts` (`doUp`).**

`doUp` registers the instance in state (inside the lock) *before* containers
start and hooks run. When `forkCreate` failed mid-way (the bucket error
above), the fork stayed registered: MySQL database already cloned, no bucket,
and a re-run of `up` prints "already exists … use it as-is". In CI a flaky
hook wedges that fork name until a human runs `down`.

The recovery path does work — `down --fork <name>` ran `forkDestroy`, which
cleaned the partial resources — but nothing tells an unattended caller to do
that.

**Fix:** on hook failure in `doUp`, run best-effort rollback: invoke
`forkDestroy` (if configured), then `composeDown`, remove the env file, and
unregister the instance — i.e. the failure leaves no trace, matching the
semantics callers already assume. Print what was rolled back. Keep the
current behavior behind the existing error if rollback itself fails (then the
`--force` down path is the escape hatch, as today).

Note: state registration before side effects is *correct* (it is what makes
concurrent slot allocation safe); the fix is rollback on failure, not
registering later.

## Finding 4: fork ↔ checkout binding is by convention, and the failure is silent

**Severity: medium (workflow footgun). Touches: `env.ts`/`cli.ts` (one new var), README.**

Hooks run with `cwd = workspace root` against the primary checkout. Creating
fork `review-x` while `app/` was still checked out on `wip-billing` succeeded
silently and seeded the fork with the *wrong branch's migrations*. Everything
reported success; the database contents were wrong.

forkspace cannot detect this (it does not know what a "branch" means), but it
can give hooks the information to resolve paths correctly.

**Fix:** export `FORKSPACE_INVOKE_DIR` (the `process.cwd()` where the command
was invoked — `findRoot` walks up, so invoking from inside a worktree already
works) into the env file / hook env. A seed hook can then resolve
`$FORKSPACE_INVOKE_DIR/migrations` instead of a hardcoded repo path, and
`cd worktree && forkspace up test --fork review-x` becomes self-binding.

Document the two safe patterns in the README:

1. run `up` from inside the worktree and make hooks use `FORKSPACE_INVOKE_DIR`;
2. CI-style: `up --no-hooks`, then run migrate/seed yourself from the correct
   checkout with the fork's env file sourced.

## Finding 5: fork hooks cannot address the baseline

**Severity: medium-high (blocks the main fork pattern for `--isolate`). Touches: `plan.ts`, `env.ts`.**

Clone-from-baseline needs the baseline's address inside `forkCreate`.
Namespace-only forks get it *by accident* (their exported port is the
baseline's port, per `planInstance`). But with `--isolate mysql` the fork's
`FORKSPACE_MYSQL_PORT` points at its own fresh container, and the clone broke:

```
mysqldump: Got error: 1049: Unknown database 'main' when selecting the database
```

The workaround — the hook parsing `.env.forkspace.<env>` to find the
baseline's port — works but is undocumented coupling to the env-file layout.
Related: the baseline's namespace name isn't available either (hooks hardcode
`main`; fixed properly by `baselineNs` in Finding 1).

**Fix:** for fork instances, additionally emit
`FORKSPACE_BASELINE_<SERVICE>_HOST` / `_PORT` (from the baseline's recorded
ports in state — `doUp` already loads state and refuses to start
baseline-dependent forks when the baseline is down) and
`FORKSPACE_BASELINE_NS` (from `baselineNs`). Hooks then clone with zero
hardcoding, regardless of the fork's isolation level.

## Finding 6 (minor): orphan detection is single-view, but a namespace spans N engines

**Severity: low (documentation now, feature later). Touches: README; later `config.ts`/`orphans.ts`.**

`listNamespaces` returns one list, but a namespace materializes in several
engines (database + prefix + bucket). The test's hook reported only MySQL's
view; an orphaned bucket with no matching database is invisible to
`ls --orphans`.

**Fix now:** document that `listNamespaces` should report the engine that is
the source of truth, and that hooks may aggregate (e.g. union of engines)
if partial creation is a concern.

**Possible later:** allow `listNamespaces` per service instead of per
environment, so `ls --orphans` can report per-engine drift
("mysql has `agent_a`, s3 does not").

## Finding 7 (fixture-side, docs only): compose healthcheck quality gates hook reliability

`up --wait` trusts compose healthchecks. mysql:8's obvious healthcheck
(`mysqladmin ping` over the socket) passes during the image's init phase
before TCP is accepting connections, so `bootstrap` ran against a
not-actually-ready server and failed. Fix belongs in user compose files
(`mysqladmin ping -h 127.0.0.1 --protocol=tcp`), but it is worth a README
note under lifecycle hooks: *hooks are only as reliable as your
healthchecks*.

---

## Suggested implementation order

| Order | Finding | Change | Why this order |
|---|---|---|---|
| 1 | 1 | `baselineNs` config | smallest change, unblocks 5's `FORKSPACE_BASELINE_NS` |
| 2 | 5 | `FORKSPACE_BASELINE_*` exports | makes clone-from-baseline hooks hardcoding-free |
| 3 | 2 | dashed ns variant | closes the "SQL-only grammar" gap |
| 4 | 3 | rollback on failed `forkCreate` | CI robustness |
| 5 | 4 | `FORKSPACE_INVOKE_DIR` + README patterns | one env var + docs |
| 6 | 6, 7 | README notes | docs only |

All changes are backward-compatible: new optional config key, new env vars,
new template variables, and a failure-path behavior change (rollback) that
only affects runs that previously ended in an error state.

A clone-from-baseline hook recipe (mysqldump-based, covering both namespace
and `--isolate` forks) should land in the README or `forkspace.example.yml`
alongside these fixes, since three of the seven findings were hit while
writing that hook naively.
