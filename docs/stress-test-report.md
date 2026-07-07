# Stress-test report: method and general findings (v0.2)

A companion to [stress-test-findings.md](stress-test-findings.md), which
covers the specific defects and proposed fixes. This document records what
was tested, how, and what the results say about the design as a whole.

## Questions under test

The test was built to pressure three claims, in order of importance:

1. **Engine neutrality.** forkspace's value should be "managing the address
   space" — minting names, ports, slots, and env files — with all
   engine-specific behavior delegated to hooks. Is that true in practice, or
   does the `{ns}` contract quietly assume SQL?
2. **The branch-migration workflow.** Can a developer keep a migrated
   baseline on `main`, fork for a branch with WIP migrations, and fork again
   to test a colleague's divergent migrations — all on one machine, without
   the schema histories interfering?
3. **CI viability.** Does the same contract survive unattended, concurrent
   use — parallel fork creation, `--no-hooks`, recovery from failed hooks,
   orphan detection?

The test deliberately did **not** cover: cloud/remote backends (out of
scope — the tool targets "local everything", locally and in CI), sandboxing
or file isolation (explicit non-goals in the README), and large-data clone
performance (see Limitations).

## Method

### Fixture design

A scratch workspace, separate from this repo, shaped like a real consumer:

```
fs-stress/
  forkspace.yml            # test env: mysql + redis + minio, allocations: app
  app/                     # git repo, three branches
    docker-compose.yml     # db (mysql:8.0), cache (redis:7), objectstore (minio)
    migrations/*.sql       # ratchet-style migrations per branch
    scripts/               # bootstrap, migrate (seed), fork-create,
                           # fork-destroy, list-namespaces
```

**Engine selection.** Three engines with three *different* natural isolation
mechanisms, chosen so that one namespace token has to materialize three ways:

| Engine | Isolation mechanism | Token used as |
|---|---|---|
| MySQL | database per fork | identifier (`wip_billing`) |
| Redis | key prefix per fork, one shared instance | prefix (`wip_billing_`, via `{ns_}`) |
| MinIO (S3 API) | bucket per fork | resource name (`app-wip-billing`) |

All three were configured `isolation: namespace` to force the token to do
the isolation work (no per-fork containers on the happy path).

**Branch topology.** Three branches with intentionally *conflicting*
migration histories, mirroring the "my WIP + reviewing a colleague's WIP"
situation:

- `main` — `001_users`, `002_orders` (the migrated baseline)
- `wip-billing` — adds `003_add_billing` (new table + column on `users`)
- `review-x` — adds `003_add_reviews` (a different 003; diverges from main,
  conflicts with `wip-billing` by version number)

**Hook strategy: clone-from-baseline.** `forkCreate` clones the baseline's
schema *and data* (including `schema_migrations`) into the fork's database
via `mysqldump`, then the `seed` hook (a ratchet migration runner) applies
only the migrations the current checkout adds on top. This is the
"database branching" workflow implemented purely in hooks, per the boundary
rule — forkspace mints the name; the hook owns the SQL.

### Test matrix

| # | Test | Exercises |
|---|---|---|
| 0 | `check` | config validation, port math |
| 1 | baseline `up` | compose orchestration, `--wait`, bootstrap → seed hooks, env file |
| 2a | fork for own WIP branch | slot allocation, clone-from-baseline, divergent migration on top |
| 2b | fork for a colleague's branch, first with the *wrong* checkout, then from a worktree | fork↔checkout binding, worktree workflow, re-fork loop |
| 3 | redis writes from three instances; bucket listing | non-SQL namespacing from one token |
| 4 | 4 concurrent `up --fork N --no-hooks` (digit fork names) | state lock, slot races, ns minting rules, CI pattern |
| 5 | plant an orphan db + drop a fork db manually | `ls --orphans` orphan/ghost detection |
| 6 | `up --fork mig-042 --isolate mysql`, destructive DDL in the fork | per-fork container isolation override, cross-instance cloning |
| 7 | `down` baseline with live forks; full teardown | guardrails, forkDestroy across three engines, residue check |

Verification was external to the tool wherever possible: `schema_migrations`
and `information_schema` queried directly per database, `redis-cli --scan`
for key listings, `mc ls` for buckets, `docker ps -a` / `docker volume ls`
for residue.

### Environment

Linux VM, Docker 29 (fuse-overlayfs), compose v5. Client tools on the host:
`mysql-client`, `redis-tools`, minio `mc`. CLI built from source
(`npm run build`, `node dist/cli.js`) at v0.2.0.

## Results

### Claim 1 — engine neutrality: **holds, with a naming caveat**

Across the entire run, forkspace executed no engine commands. One token per
fork drove a MySQL database, a Redis key prefix, and an S3 bucket; writes
under the same logical key (`session:1`) from two forks landed in disjoint
keys in one shared Redis; `forkDestroy` removed exactly one fork's resources
in all three engines (verified: 2 prefixed keys deleted, others untouched).

The caveat is precise: the *mechanism* is engine-neutral, but the *token
grammar* (`[a-z0-9_]+`) is not — S3 bucket names forbid underscores, so the
hook had to re-transform the token and the exported `S3_BUCKET` stopped
matching reality (finding 2). Neutrality lives or dies in the naming rules,
not in drivers. The related empty-baseline-token defect (finding 1) is the
same lesson: names are the product, and both defects are name-minting bugs.

### Claim 2 — branch-migration workflow: **holds**

After the full sequence, one MySQL container held three coexisting schema
histories:

| Database | schema_migrations | Distinguishing schema |
|---|---|---|
| `main` | 001, 002 | no 003 artifacts |
| `wip_billing` | 001, 002, 003_add_billing | `invoices` table, `users.billing_email` |
| `review_x` | 001, 002, 003_add_reviews | `reviews` table |

Cloned baseline data was present in forks (row counts matched), destructive
work in a `--isolate mysql` fork (dropped table, dropped column) left the
baseline byte-identical, and dropping forks removed their histories without
touching `main`. The "edit a WIP migration → re-fork" loop (`down` + `up`)
costs about one second, which makes *re-fork, never repair* a practical
default.

Two workflow hazards surfaced, both convention gaps rather than engine gaps:
the fork silently seeds from whatever the primary checkout happens to be
(finding 4), and clone-from-baseline needs baseline addresses that fork hooks
aren't given (finding 5, breaks under `--isolate`).

### Claim 3 — CI viability: **holds, with one robustness gap**

- 4 concurrent fork creations completed in 0.13s total with unique slots and
  a consistent state file — the state lock held with zero retry artifacts.
- Digit fork names (`--fork 1`, the `$CI_NODE_INDEX` pattern) minted valid
  tokens (`f_1`) per the documented rules.
- `--no-hooks` forks behaved as pure address-space reservations, as the CI
  contract intends.
- Orphan detection correctly classified a planted orphan (engine resource
  with no state entry) and a ghost (state entry whose engine resource was
  removed behind forkspace's back).
- The gap: a fork whose `forkCreate` fails stays registered as live
  (finding 3). Recovery is manual (`down`, then `up`). Unattended CI needs
  the rollback fix before flaky hooks stop being an operational nuisance.

### Timings

Measured on the VM above (single run, small data; indicative not
benchmarked):

| Operation | Time |
|---|---|
| baseline `up` (3 containers, healthchecks, bootstrap + 2 migrations) | ~7s |
| namespace fork `up` (clone + 1 migration) | ~0.35s |
| namespace fork `down` (3-engine destroy) | ~0.4s |
| 4 concurrent `--no-hooks` forks | 0.13s total |
| `--isolate mysql` fork `up` (fresh mysql container + clone + migrate) | ~8s |

The two orders of magnitude between namespace forks (sub-second) and
container forks (container boot time) is the empirical argument for
namespace being the default isolation level and `container` the per-fork
escape hatch.

## Limitations and threats to validity

- **Small data.** `mysqldump | mysql` cloning is sub-second at fixture scale;
  at real dev-database scale it becomes the slow path. Local MySQL has no
  cheap copy-on-write, so large datasets need a different hook strategy
  (schema-only clone + targeted seed, or volume snapshots for
  container-isolated forks). Untested here.
- **One platform.** Linux + Docker 29 + compose v5 only. The `!override`
  port-remap tag requires compose ≥ 2.24; older composes were not exercised.
- **Single-user workspace.** Concurrency was tested within one machine and
  one state file, matching the tool's scope. Nothing here validates shared
  state across machines.
- **Healthcheck dependence.** `up --wait` trusts compose healthchecks; the
  fixture initially shipped a subtly wrong mysql healthcheck and hooks ran
  against a not-ready server (finding 7). Results after the fix assume
  healthchecks are correct — the tool has no independent readiness check.

## Overall verdict

The address-space thesis survives contact: every observed defect was a
naming or addressing gap (empty baseline token, single-grammar token,
missing baseline addresses, missing invocation context, non-rolled-back
registration), and none called for engine-aware code or a driver layer. The
branch-migration workflow works end-to-end at speeds that make forks
disposable, which is the property the whole design leans on. The defect list
is short, backward-compatible, and concentrated in `env.ts`/`config.ts`/
`plan.ts`/`cli.ts` — see
[stress-test-findings.md](stress-test-findings.md) for fixes and ordering.

## Reproducing

1. Docker daemon + compose ≥ 2.24; `mysql-client`, `redis-tools`, minio `mc`
   on the host.
2. Build the CLI: `npm run build` in this repo.
3. Recreate the fixture per **Method** (workspace with `forkspace.yml`, the
   three-service compose file, branch topology, and the five hook scripts —
   the clone-from-baseline `forkCreate` is the only non-obvious one).
4. Run the test matrix in order; verify with direct engine queries rather
   than tool output. `mysql:8` healthchecks must ping over TCP
   (`mysqladmin ping -h 127.0.0.1 --protocol=tcp`), or bootstrap runs before
   the server accepts connections.
