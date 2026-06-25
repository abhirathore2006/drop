# 0009 — Build-time CLI version + self-updating served `install.sh`

Status: Accepted

## Context

Users install the CLI with `curl <API>/install.sh | sh`, so the CLI's origin is whatever API served
it. We want `drop --version` to be meaningful, to match release tags, and we want a frictionless
`drop update`.

## Decision

- **Version is baked at build time**: `build.mjs` computes `VERSION = <package.json version>+<git
  short sha>` and defines `__DROP_VERSION__` (esbuild `define`); `src/version.ts` reads it. So
  `drop --version` → e.g. `2.0.0+c11c77f`. For a release, bump `package.json` so the CLI matches
  the tag (`vX.Y.Z`).
- **The API serves `install.sh`** (`src/api/install.ts`) with its own URL baked in; the installer
  writes `~/.config/drop/config.json` (`apiBase` + `installUrl`) and drops `~/.local/bin/drop`.
- **`drop update`** re-fetches the CLI from the recorded `installUrl` and prints current → target
  before updating.

## Consequences

- A clean release flow: merge → bump `package.json` → commit → tag → push.
- The CLI knows where it came from, so updates need no extra flags.
- Tags pushed before a version bump (e.g. an intentional "tag as-is" release) will report the older
  embedded version — bump first if you want them to match.
