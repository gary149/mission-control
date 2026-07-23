# 0002: Node runtime, npm distribution

Date: 2026-07-23
Status: accepted
Revises: decision #3 in SPEC.md (was: TypeScript on Bun, `bun build --compile` single binary)

## Context

v0 shipped as a Bun-compiled binary with a rolling GitHub release rebuilt on every
push: three cross-compiled targets, a delete-and-recreate release job, and macOS
ad-hoc codesigning in the installer (arm64 SIGKILLs unsigned binaries). That
pipeline was standing infrastructure serving no one: every consumer is a
developer machine or a server that can run npm, and the "no toolchain" install
was never exercised. It also made Bun a second runtime to install and trust on
every host, and the compiled entrypoint forced three-way spawn-resolution logic
in the supervisor launcher.

## Decision

- Runtime is Node.js >= 22.13 (`node:sqlite` unflagged); no Bun anywhere.
- Storage stays dependency-free via `node:sqlite`; the package has zero runtime
  dependencies and no native modules.
- Source stays TypeScript with `.ts` relative import specifiers; `tsc`
  (`rewriteRelativeImportExtensions`) emits `dist/`, and development runs source
  directly through Node's type stripping (>= 22.18).
- Distribution is the npm package: `bin: dist/mc.js`, built by the `prepare`
  script so both registry installs and `npm install -g github:...` work. The
  release workflow, install.sh, and all codesigning are deleted.
- Tests run under `node:test` against the same stub-harness fixtures.

## Consequences

- One runtime everywhere: hosts that run mc already run Node (the OpenClaw box
  is on Node 22); nothing to sign, no per-arch artifacts, updates are
  `npm install -g` again (or `git pull` in a linked clone).
- The "curl one binary onto a locked-down box" story is gone; a host now needs
  Node + npm. Accepted: no such host exists in practice.
- The npm registry name `mission-control` is already taken by an unrelated
  package; publishing to the registry requires a scoped name (e.g.
  `@gary149/mission-control`). Git installs are unaffected by the collision.
- `node:sqlite` still emits an ExperimentalWarning; the bin shebang suppresses
  it (`env -S node --disable-warning=ExperimentalWarning`), which also scopes
  support to platforms whose `env` supports `-S` (macOS, modern Linux) - the
  same platforms the binaries targeted.
