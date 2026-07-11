# TODO: forkspace UI (GUI + TUI)

Two complementary surfaces on top of the CLI — same data, different density.
Neither replaces `up` / `down` / `env` for scripting and CI.

| Surface | Analogy | Best for |
|---|---|---|
| **GUI** | diagram come alive | understanding sharing, onboarding, "what's connected to what" |
| **TUI** | htop for forks | day-to-day monitoring, quick scan, tear-down from the terminal |

---

## GUI

A lightweight visual dashboard inspired by the three-column
[namespacing diagram](diagrams/namespacing.svg). Read-mostly view of what
`forkspace ls` already knows, with the layout that makes sharing vs isolation
obvious at a glance.

### Why

The namespacing diagram surfaced a UX the CLI can't quite deliver: you see
**use-cases**, **containers**, and **materialized resources** in one frame,
with arrows that trace ports and namespace tokens separately. That's the mental
model people need when three agents, a migration fork, and a dev baseline are
all running. Today you reconstruct it from `ls`, env files, and `docker ps`.

### Layout (sketch)

Three columns, one row per instance (baseline + forks):

| Use-case | Containers / env | Materialized |
|---|---|---|
| env file name, `FORKSPACE_NS`, slot | shared baseline services, host ports, isolation level | databases, table prefixes, buckets, queue names — whatever `listNamespaces` / hooks report |

- **Solid arrows** — instance → host port (same endpoint, many forks)
- **Dashed arrows** — `FORKSPACE_NS` → engine-specific resource (what hooks created)
- Color per engine (MySQL, DynamoDB, S3, …) matching the diagram legend

Environment boundaries (`dev` vs `test`) are separate panels or tabs; port
ranges don't mix.

### GUI MVP

Read-only, local, polls on an interval or watches `.forkspace/state.json`:

- [ ] List instances from state (`ls` data model)
- [ ] Show compose project name, slot, backing (`container` vs `namespace-only`)
- [ ] Show per-service ports and isolation level from `forkspace.yml`
- [ ] Show `FORKSPACE_NS` and resolved export values from each `.env.forkspace.*`
- [ ] Optional: `docker compose ps` status badges on container nodes
- [ ] Optional: `ls --orphans` highlights (orphan / ghost namespaces)

No `up` / `down` in v0 — click-to-copy env file path or `forkspace env` command is enough.

### GUI stretch

- Live orphan diff when baseline is up
- Click a fork → show the exact `forkspace down test --fork <name>` to tear it down
- `--ps` health indicators (green / stopped / missing)
- Diff two forks side-by-side (ports, ns, exports)

---

## TUI

`forkspace top` — htop for all forks. A full-screen terminal dashboard that
refreshes in place so you can leave it open while agents come and go.

### Why

Most of the time you don't need the graph — you need a fast answer to "what's
running, on which ports, and is anything orphaned?" The TUI is the always-open
tab next to your agent sessions: dense table, keyboard-driven, zero context
switch to a browser.

### Layout (sketch)

```
 forkspace top — acme workspace                    refresh: 2s  [q]uit
 ─────────────────────────────────────────────────────────────────────────
 ENV    FORK          SLOT  BACKING   NS           MYSQL   DYNAMO  APP   PS
 dev    (baseline)      0   container main         :3306   :8000   —     ●●●●
 test   (baseline)      0   container main         :3406   :8100   —     ●●●●
 test   agent-a         1   ns-only   agent_a      :3406   :8100   —     —
 test   agent-b         2   ns-only   agent_b      :3406   :8100   —     —
 test   e2e             3   ns-only   e2e          :3406   :8100  :4130  —
 test   mig-042         4   container mig_042      :3446   :8100   —     ●○○○
 ─────────────────────────────────────────────────────────────────────────
 orphans: 1 (ghost: leftover_ns)     ghosts: 0     [o]rphans detail  [Enter] env
```

- One row per instance; sort by env, slot, fork name, age
- **PS** column: compact container health from `ls --ps` (● running, ○ stopped, — namespace-only)
- Footer: orphan/ghost summary, key hints
- Highlight row under cursor; `Enter` prints `source .env.forkspace…` or pipes `forkspace env`

### TUI MVP

- [ ] `forkspace top` (alias: `forkspace tui`?) — full-screen, default 2s refresh
- [ ] Table of all instances from state: env, fork, slot, backing, ns, key ports
- [ ] `q` / `Ctrl-C` quit; `r` force refresh
- [ ] `Enter` on row → run `forkspace env <env> [--fork <name>]` or copy env path
- [ ] `d` on fork row → confirm + `forkspace down` (the one action worth having in-terminal)
- [ ] Orphan count in footer; `o` toggles orphan detail pane

### TUI stretch

- Filter: `/` to search fork names; `1`/`2` toggle env columns
- `s` sort cycle (slot / fork / env / age)
- `l` drill into a row → expanded port list + export snippet (htop-style detail panel)
- `w` watch mode: flash row on slot allocation / new fork / down
- Multi-workspace: `forkspace top --all` if cwd discovery finds several roots (probably later)

### TUI non-goals

- Not a REPL for `forkspace.yml`
- Not a log tailer (link out to `docker compose logs` on `l` + service key)
- No mouse required (but clicks OK if the lib supports it)

---

## Shared

### Non-goals (both)

- Not a compose editor or `forkspace.yml` authoring tool
- Not a hook debugger — terminal stays the place for hook output
- Not required for CI — env files remain the contract

### Data sources

- `.forkspace/state.json` — instances, slots, ports, ns tokens
- `forkspace.yml` — isolation levels, allocations, service names
- `.env.forkspace.*` — resolved exports
- `forkspace ls --ps` / `docker compose ps` — container health
- `forkspace ls --orphans` — orphan / ghost diff

### Open questions

- **Materialized detail in GUI.** State knows tokens; engines know tables/buckets.
  GUI right column needs hook output or stays token-only in v0?
- **GUI delivery.** `forkspace gui` serving a local static page is probably enough;
  no daemon. TUI is in-process (see below).
- **TUI library.** `blessed`, `ink` (React), or lighter `cli-table` + screen clear for
  MVP? Full htop feel wants a real TUI lib with keyed input and partial redraw.
- **Relationship to diagrams.** SVGs are documentation; GUI is the live graph. TUI is
  the dense ticker — same rows as the diagram's left column, without the arrows.

### Reference

- [namespacing.svg](diagrams/namespacing.svg) — GUI layout reference
- [all-at-once.svg](diagrams/all-at-once.svg) — multi-environment bird's-eye view
- `forkspace ls`, `forkspace ls --ps`, `forkspace ls --orphans` — shared data layer
