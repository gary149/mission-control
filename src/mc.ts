#!/usr/bin/env bun
import { cliMain } from "./cli";
import { supervise } from "./core/supervisor";

const argv = process.argv.slice(2);

if (argv[0] === "_supervise") {
  // Hidden entrypoint: the detached per-run supervisor process.
  const runId = argv[1];
  if (!runId) {
    console.error("mc _supervise: run id required");
    process.exit(1);
  }
  await supervise(runId);
  process.exit(0);
}

await cliMain(argv);
