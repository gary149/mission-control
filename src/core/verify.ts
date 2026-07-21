import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Run, RunSpec, Verdict } from "./types";

interface Check {
  name: string;
  applicable: boolean;
  passed: boolean;
  detail: string;
}

export interface VerifyResult {
  verdict: Verdict;
  evidence: string;
}

/**
 * The verdict promises exactly one thing: the checks the spec declared passed,
 * confirmed mechanically. Nothing about quality (CONTEXT.md: Verdict).
 */
export function verify(run: Run, spec: RunSpec, exitCode: number | null, isGit: boolean): VerifyResult {
  const checks: Check[] = [];

  checks.push({
    name: "exit_code",
    applicable: true,
    passed: exitCode === 0,
    detail: `process exited ${exitCode}`,
  });

  if (isGit) {
    const porcelain = spawnSync("git", ["-C", run.workdir, "status", "--porcelain"], { encoding: "utf8" });
    const changed = porcelain.stdout.trim().length > 0;
    checks.push({
      name: "git_effect",
      applicable: true,
      passed: changed,
      detail: changed ? `${porcelain.stdout.trim().split("\n").length} path(s) changed` : "no changes in worktree",
    });
  }

  for (const artifact of spec.artifacts) {
    const path = join(run.workdir, artifact);
    const exists = existsSync(path);
    const size = exists ? statSync(path).size : 0;
    checks.push({
      name: `artifact:${artifact}`,
      applicable: true,
      passed: exists && size > 0,
      detail: exists ? `${size} bytes` : "missing",
    });
  }

  const evidence = JSON.stringify(checks);
  const applicable = checks.filter((c) => c.applicable);
  const anyFailed = applicable.some((c) => !c.passed);

  if (anyFailed) return { verdict: "failed_verification", evidence };
  if (spec.visual) return { verdict: "needs_human_look", evidence };
  // Exit code alone proves nothing was checked; without a declared artifact or
  // a git effect the run can at best be unverifiable (SPEC: Verification).
  const substantive = applicable.some((c) => c.name !== "exit_code");
  return { verdict: substantive ? "verified" : "unverifiable", evidence };
}
