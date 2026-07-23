#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { cliMain } from "./cli.ts";
import { supervise } from "./core/supervisor.ts";

// Hidden entrypoint: the detached per-run supervisor process. The run id
// travels via env, not argv, so the invocation is identical from source
// (node type stripping) and from the compiled dist entrypoint.
const superviseId = process.env.MC_SUPERVISE;
if (superviseId) {
  await supervise(superviseId);
  process.exit(0);
}

await cliMain(process.argv.slice(2));
