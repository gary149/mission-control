# 0002: Node runtime, npm distribution, committed dist

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

Two install-time-build designs were tried and rejected on evidence:

1. `prepare` -> `tsc` -> `dist/`: npm does not install devDependencies before
   running `prepare` for git installs (verified on npm 10.9 and 11.11), and an
   npx-fetched compiler raced npm's pack step, producing nondeterministically
   truncated packages (observed: 5, 7, or 16 of 16 files, varying with npx
   cache warmth). An install-time build is a moving part that fails silently -
   the exact failure class this project bans.
2. Shipping `src/*.ts` as the bin (no build at all): Node refuses to type-strip
   files under `node_modules` by design (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`),
   so an installed package must ship JavaScript.

## Decision

- Runtime is Node.js >= 22.13 (`node:sqlite` unflagged); no Bun anywhere.
- Storage stays dependency-free via `node:sqlite`; the package has zero runtime
  dependencies and no native modules.
- **`dist/` is committed and shipped as-is.** Installs run no lifecycle scripts:
  `files: ["dist"]`, `bin: dist/mc.js`, no `prepare`. Both
  `npm install -g github:gary149/mission-control` and `npm link` from a clone
  work deterministically on npm 10 and 11.
- Freshness is a CI gate: build then `git diff --exit-code -- dist`, so a stale
  committed dist can never merge.
- Development runs the TypeScript source directly via Node's type stripping
  (>= 22.18); `erasableSyntaxOnly` keeps the source strip-runnable, and source
  imports use `.ts` specifiers that `tsc` (`rewriteRelativeImportExtensions`)
  rewrites for the emitted dist.
- Tests run under `node:test` against the same stub-harness fixtures.

## Consequences

- One runtime everywhere; installs are deterministic file copies with nothing
  to sign, no per-arch artifacts, and no install-time compilation to race.
- Generated code lives in the repo. Accepted for a ~90 KB dist with the CI
  freshness gate making drift impossible to merge; contributors run
  `npm run build` before committing src changes.
- The "curl one binary onto a locked-down box" story is gone; a host now needs
  Node + npm. Accepted: no such host exists in practice.
- The npm registry name `mission-control` is already taken by an unrelated
  package; publishing to the registry requires a scoped name (e.g.
  `@gary149/mission-control`). Git installs are unaffected by the collision.
- `node:sqlite` still emits an ExperimentalWarning; the bin shebang suppresses
  it (`env -S node --disable-warning=ExperimentalWarning`), which also scopes
  support to platforms whose `env` supports `-S` (macOS, modern Linux) - the
  same platforms the binaries targeted.
