# TODO: forkspace GUI

A lightweight visual dashboard inspired by the three-column
[namespacing diagram](diagrams/namespacing.svg). Not a replacement for the
CLI — a read-mostly view of what `forkspace ls` already knows, with the
layout that makes sharing vs isolation obvious at a glance.

## Why

The namespacing diagram surfaced a UX that the CLI can't quite deliver: you
see **use-cases**, **containers**, and **materialized resources** in one
frame, with arrows that trace ports and namespace tokens separately. That's
the mental model people need when three agents, a migration fork, and a dev
baseline are all running. Today you reconstruct it from `ls`, env files, and
`docker ps`.

## Layout (sketch)

Three columns, one row per instance (baseline + forks):

| Use-case | Containers / env | Materialized |
|---|---|---|
| env file name, `FORKSPACE_NS`, slot | shared baseline services, host ports, isolation level | databases, table prefixes, buckets, queue names — whatever `listNamespaces` / hooks report |

- **Solid arrows** — instance → host port (same endpoint, many forks)
- **Dashed arrows** — `FORKSPACE_NS` → engine-specific resource (what hooks created)
- Color per engine (MySQL, DynamoDB, S3, …) matching the diagram legend

Environment boundaries (`dev` vs `test`) are separate panels or tabs; port
ranges don't mix.

## MVP scope

Read-only, local, polls on an interval or watches `.forkspace/state.json`:

- [ ] List instances from state (`ls` data model)
- [ ] Show compose project name, slot, backing (`container` vs `namespace-only`)
- [ ] Show per-service ports and isolation level from `forkspace.yml`
- [ ] Show `FORKSPACE_NS` and resolved export values from each `.env.forkspace.*`
- [ ] Optional: `docker compose ps` status badges on container nodes
- [ ] Optional: `ls --orphans` highlights (orphan / ghost namespaces)

No `up` / `down` in v0 — click-to-copy env file path or `forkspace env` command is enough.

## Stretch

- Live orphan diff when baseline is up
- Click a fork → show the exact `forkspace down test --fork <name>` to tear it down
- `--ps` health indicators (green / stopped / missing)
- Diff two forks side-by-side (ports, ns, exports)

## Non-goals

- Not a compose editor or `forkspace.yml` authoring tool
- Not a log viewer or hook debugger (terminal stays the place for that)
- Not required for CI — env files remain the contract

## Open questions

- **Materialized column source of truth.** State knows namespace tokens; engines
  know actual tables/buckets. Populate from hook output (`listNamespaces` extended?)
  or stay token-only until hooks report more?
- **Electron vs web vs TUI.** A local static page served by `forkspace gui` that
  reads state + env files is probably enough; no daemon required.
- **Relationship to diagrams.** The SVGs are documentation; the GUI is the live
  version of the same layout. Reuse the column/arrow vocabulary.

## Reference

- [namespacing.svg](diagrams/namespacing.svg) — primary layout reference
- [all-at-once.svg](diagrams/all-at-once.svg) — multi-environment bird's-eye view
- `forkspace ls`, `forkspace ls --ps`, `forkspace ls --orphans` — data sources
