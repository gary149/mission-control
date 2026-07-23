#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
import { cliMain } from "./cli.js";
import { supervise } from "./core/supervisor.js";
// Hidden entrypoint: the detached per-run supervisor process. The run id
// travels via env, not argv, so the invocation is identical from the shipped
// dist and from source under node's type stripping (see ADR 0002).
const superviseId = process.env.MC_SUPERVISE;
if (superviseId) {
    await supervise(superviseId);
    process.exit(0);
}
await cliMain(process.argv.slice(2));
