# 0008 — `drop.yaml` is the only site/app config (`_drop.json` removed)

Status: Accepted

## Context

Site/app configuration was historically a `_drop.json` file. JSON is awkward for humans to author
and comment, and we ended up supporting two formats during a transition, which is a maintenance and
documentation burden.

## Decision

`drop.yaml` is the **single, canonical** config for both static sites and container apps. YAML is
comment-friendly and matches what the examples and docs show. `_drop.json` support and the
conversion shim have been **removed** (`git log` around `dc07599` /
`refactor: drop.yaml is the only site config`). A one-shot `drop migrate-config` existed to convert
old `_drop.json` files.

## Consequences

- One format to parse, validate (`zod`), document, and teach.
- Examples (`examples/*/drop.yaml`) are the source of truth for the schema in practice.
- Anyone still on `_drop.json` must convert (the migrate command / manual) before deploying.
