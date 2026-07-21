#!/usr/bin/env bun
import { cliMain } from "./cli";
import { supervise } from "./core/supervisor";

// Hidden entrypoint: the detached per-run supervisor process. The run id
// travels via env, not argv, so the invocation is identical for source runs,
// `bun build` bundles, and compiled binaries (argv indexing differs across them).
const superviseId = process.env.MC_SUPERVISE ?? (process.argv[2] === "_supervise" ? process.argv[3] : undefined);
if (superviseId) {
  await supervise(superviseId);
  process.exit(0);
}

await cliMain(process.argv.slice(2));
