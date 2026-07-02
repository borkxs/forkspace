# forkspace

`forkspace` is a standalone CLI for managing isolated local dev/test environments
for multi-repo, multi-service stacks.

Run your stack. Fork it per agent or branch. Tear forks down without ceremony.

```bash
forkspace up dev                    # persistent working environment
forkspace up test                   # clean baseline test stack
forkspace up test --fork agent-a    # agent-a's own isolated copy
forkspace up test --fork agent-b    # agent-b's, on its own ports
forkspace down test --fork agent-a  # gone, volumes dropped
```

## Why

Git worktrees give agents and branches isolated *file trees*, but they all share
one machine: one port 3306, one MySQL data directory, one Docker network
namespace. Two agents running tests against "the" local database corrupt each
other's feedback loops. Full per-workspace VMs or sandboxed Docker daemons solve
this with a sledgehammer; most stacks just need their compose services forked.

`forkspace` is the lightweight middle: a workspace-level compose manager built
on `docker compose -p` as the isolation primitive.

- **Named environments** (`dev`, `test`) with different lifecycle rules —
  `dev` is persistent, `test` is ephemeral and seeded on `up`.
- **Forking** — `--fork agent-a` gets its own compose project, its own named
  volumes (free with `-p`), and deterministic ports one slot up
  (`basePort + slot × slotSize`).
- **Shared vs. forked services per environment** — usually only the SQL schema
  diverges between branches; mark DynamoDB/queues/object storage `scope: shared`
  and forks reuse the baseline containers instead of duplicating everything.
- **Cross-repo service ownership** — when two repos' compose files both claim
  DynamoDB on port 8000 with incompatible configs, `forkspace.yml` names one
  owner and the other is never started. `forkspace check` detects the conflicts.
- **An env-file contract** — every instance writes `.env.forkspace.<env>[.<fork>]`
  with `FORKSPACE_*_PORT/_HOST` plus your own templated exports
  (`DATABASE_URL: "mysql://root:root@{host}:{port}/app"`). Apps, tests, CI, and
  agents all consume the same contract.

## Install

```bash
npm install
npm run build
npm link        # or: node dist/cli.js
```

## Setup

At your workspace root (the directory containing your repos):

```bash
forkspace init      # writes a starter forkspace.yml
forkspace check     # validates compose files, services, and port math
```

See `forkspace.example.yml` for a full multi-repo example with fork/shared
scoping and bootstrap/seed hooks.

## Commands

| Command | What it does |
|---|---|
| `up <env> [--fork <name>] [--isolate <svcs>] [--no-hooks]` | Start an instance. `--isolate mysql` forks only MySQL and shares the rest, overriding config scope. |
| `down <env> [--fork <name>] [--keep-volumes]` | Stop an instance. Drops volumes unless the environment is `persistent`. Refuses to drop a baseline with live forks. |
| `ls [--ps]` | List instances, slots, ports; `--ps` queries docker for container status. |
| `env <env> [--fork <name>]` | Print the instance's env file (pipe into `source`). |
| `check` | Static validation: compose files exist, services exist, no basePort collisions, no slot-range overlaps. |
| `init` | Write a starter `forkspace.yml`. |

## How isolation works

Each instance is a docker compose project named `fs-<workspace>-<env>[-<fork>]`.

- **Networks and volumes**: compose prefixes both with the project name, so
  forks get fresh data directories with zero configuration.
- **Ports**: forkspace generates a per-instance override file using compose's
  `!override` tag (compose ≥ 2.24) that remaps only host ports:

  ```yaml
  services:
    db:
      ports: !override
        - "3416:3306"
  ```

- **Slots**: the baseline is slot 0; forks take the lowest free slot ≥ 1,
  probed against both recorded state (`.forkspace/state.json`) and actual
  host port availability.

## CI

CI doesn't need the daemon-side niceties — it consumes the same contract:
run `forkspace up test --fork "$CI_NODE_INDEX" --no-hooks`, source the env
file, run tests, `forkspace down`. `forkspace.yml` stays the single source of
truth for what "test environment" means everywhere.

## What forkspace is not

- Not a sandbox. Forks isolate *state* (data, ports, networks), not code
  execution. Pair with worktrees for file isolation or a sandboxing tool for
  untrusted agents.
- Not a compose replacement. Your repos keep their compose files; forkspace
  orchestrates them.

## Positioning

Standalone developer-infrastructure tool, same family as Hookrelay and Envgate —
not part of `@b2bkit`.
