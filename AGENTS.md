# AGENTS.md

## Cursor Cloud specific instructions

`forkspace` is a standalone TypeScript CLI (no long-running server/UI). It orchestrates
`docker compose` stacks on behalf of other repos; it is not itself a service you "run".

Standard commands live in `package.json` scripts — use those rather than duplicating here:
- `npm run typecheck` — static check (this repo has no separate lint script; typecheck is the lint gate)
- `npm run build` — compile to `dist/` (only needed to exercise the published `bin`/`dist/cli.js`)
- `npm test` — vitest (`test/forkspace.test.ts`); runs straight from `src` via tsx, no build required
- `npm run dev -- <args>` — run the CLI from source (e.g. `npm run dev -- check`)

Non-obvious caveats:
- The compose-orchestration commands (`up`, `down`, `ls --ps`) shell out to the `docker`
  CLI and require a running Docker daemon. Docker is a system dependency and is intentionally
  NOT part of the update script; the unit tests and the `check`/`init`/`env` commands do not
  need Docker. If you need to exercise `up`/`down` end-to-end, install Docker yourself (see the
  daemon config notes below) — the update script only refreshes npm deps.
- Docker daemon in this VM: install docker-ce, set storage driver `fuse-overlayfs` with
  `features.containerd-snapshotter: false` in `/etc/docker/daemon.json` (required for Docker 29+),
  switch to iptables-legacy, then run `sudo dockerd` (systemd is not managing it). `chmod 666
  /var/run/docker.sock` (or add your user to the `docker` group) to use docker without sudo.
- Run forkspace from a *workspace root* containing a `forkspace.yml` and the referenced compose
  files. `check` correctly exits non-zero when compose files are missing — that is expected, not a bug.
- `up`/`down` write `.env.forkspace.*` files and `.forkspace/` state into the workspace root
  (both gitignored), not into this repo.
