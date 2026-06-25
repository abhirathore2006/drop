# 0010 — Corp CA: record at setup, auto-mount into k3s, fast-fail on x509

Status: Accepted

## Context

On a corporate network with a TLS-inspecting proxy (e.g. Zscaler), image pulls fail with
`x509: certificate signed by unknown authority` unless the CA is trusted. There are **two distinct
trust stores**:

- the **podman VM** (so the *engine* can pull k3s/floci/postgres), and
- the **in-cluster containerd** inside the k3s container (so KEDA/CNPG/app images pull).

`make setup CORP_CA=…` only handled the first. Forgetting `DROP_CORP_CA` on `make up` left
in-cluster pulls failing, and — worse — `helm --wait` then hung for its full **10-minute** timeout
with no obvious cause.

## Decision

- **Record once**: `make setup CORP_CA=<path>` injects the CA into the VM **and records the resolved
  path** (`.run/corp-ca`), after validating the file exists (a wrong path fails fast, records
  nothing).
- **Auto-mount**: `cluster-up.sh` defaults `DROP_CORP_CA` from `.run/corp-ca` and mounts the bundle
  into the k3s container at `/etc/ssl/certs/ca-certificates.crt`. So `make up` "just works" with no
  repeated flags; an explicit `DROP_CORP_CA` still wins; a stale/missing recorded path is warned and
  ignored.
- **Fail fast**: before installing operators, a preflight test-pull inside k3s detects an `x509`
  failure in seconds and aborts with the exact fix, instead of hanging on `helm --wait`.

Use the **full** CA bundle (public roots + corp CA) for the in-cluster mount — it *replaces* the
container's bundle; the lone corp cert would drop the public roots.

## Consequences

- One-time `make setup CORP_CA=…`; every later `make up` auto-trusts the proxy.
- A missing/wrong CA is a ~5-second clear error, never a silent 10-minute hang.
- Off a corp network, none of this triggers (no CA recorded, pulls just work).
