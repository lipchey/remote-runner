# Local Fallback Child Environment Design

**Status:** approved.

## Problem

`workload.childEnvironment` is applied to remote workload children, but `NodeProfileServices.runLocal`
currently starts an automatic local fallback with only the runner process environment. A consumer
that relies on manifest-owned environment overrides can therefore prepare dependency state under one
configuration and execute the fallback workload under another.

## Design

The local workload launch will pass `profile.workload.childEnvironment` to `runStreamingProcess`.
The process boundary already merges request-specific values over `process.env`, so manifest values
remain authoritative while unrelated parent variables are preserved. Remote execution is unchanged.

The fix stays inside `remote-runner`; consumers must not duplicate manifest values in wrapper scripts.
An integration-style unit test will instantiate `NodeProfileServices`, run a real local Node child,
and assert that a manifest-only canary reaches that child. This test covers the missing wiring rather
than merely testing manifest parsing or a fake runtime.

## Acceptance

- The new local-child test fails before the implementation and passes afterward.
- The complete remote-runner test, typecheck, format-check, and build commands pass.
- The installed CLI is refreshed from the fixed revision.
- Ariadne completes `./scripts/verify --full` with `REMOTE_RUNNER_MODE=local` and without manually
  exporting its manifest-declared `PNPM_CONFIG_*` variables.
