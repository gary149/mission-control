import { spawnSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import type { Run, RunSpec, Verdict } from "./types.ts";

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
 * Pure path math: a declared artifact must be relative and stay inside the
 * (hypothetical) workdir. Used at preflight, before the workdir exists.
 */
export function artifactStaysInside(artifact: string): boolean {
  if (isAbsolute(artifact)) return false;
  const root = resolve(sep, "mc-root", "work");
  const resolved = resolve(root, artifact);
  return resolved === root || resolved.startsWith(root + sep);
}

/** Resolve an artifact against the real workdir, refusing escapes (incl. symlinks). */
function containedArtifactPath(workdir: string, artifact: string): string | null {
  if (!artifactStaysInside(artifact)) return null;
  const root = realpathSync(workdir);
  const resolved = resolve(root, artifact);
  if (!(resolved === root || resolved.startsWith(root + sep))) return null;
  if (existsSync(resolved)) {
    const real = realpathSync(resolved);
    if (!(real === root || real.startsWith(root + sep))) return null;
  }
  return resolved;
}

/**
 * The verdict promises exactly one thing: the checks the spec declared passed,
 * confirmed mechanically. Nothing about quality (CONTEXT.md: Verdict).
 * `parserHealthy` is false when the native stream could not be read (unparsed
 * lines or no terminal result event) - blindness caps the verdict at
 * unverifiable rather than pretending the checks tell the whole story.
 */
export function verify(
  run: Run,
  spec: RunSpec,
  exitCode: number | null,
  isGit: boolean,
  parserHealthy = true,
  headAtLaunch: string | null = null,
): VerifyResult {
  const checks: Check[] = [];

  checks.push({
    name: "exit_code",
    applicable: true,
    passed: exitCode === 0,
    detail: `process exited ${exitCode}`,
  });

  if (isGit) {
    // Effect = commits made since launch OR a dirty tree. An agent that does
    // its job and commits everything leaves a CLEAN tree - that must pass
    // (fleet evidence: clean-committing runs were failed for exactly this).
    const porcelain = spawnSync("git", ["-C", run.workdir, "status", "--porcelain"], { encoding: "utf8" });
    const dirtyPaths = porcelain.stdout.trim() ? porcelain.stdout.trim().split("\n").length : 0;
    let commits = 0;
    if (headAtLaunch) {
      const count = spawnSync("git", ["-C", run.workdir, "rev-list", "--count", `${headAtLaunch}..HEAD`], {
        encoding: "utf8",
      });
      if (count.status === 0) commits = Number(count.stdout.trim()) || 0;
    }
    const changed = dirtyPaths > 0 || commits > 0;
    checks.push({
      name: "git_effect",
      applicable: true,
      passed: changed,
      detail: changed ? `${commits} commit(s), ${dirtyPaths} path(s) changed` : "no commits and clean tree",
    });
  }

  for (const artifact of spec.artifacts) {
    const path = containedArtifactPath(run.workdir, artifact);
    if (!path) {
      checks.push({ name: `artifact:${artifact}`, applicable: true, passed: false, detail: "escapes workdir" });
      continue;
    }
    const exists = existsSync(path);
    const size = exists ? statSync(path).size : 0;
    checks.push({
      name: `artifact:${artifact}`,
      applicable: true,
      passed: exists && size > 0,
      detail: exists ? `${size} bytes` : "missing",
    });
  }

  checks.push({
    name: "parser_health",
    applicable: true,
    passed: parserHealthy,
    detail: parserHealthy ? "native stream parsed cleanly" : "native stream unreadable or no result event",
  });

  const evidence = JSON.stringify(checks);
  const anyFailed = checks.filter((c) => c.name !== "parser_health").some((c) => c.applicable && !c.passed);

  if (anyFailed) return { verdict: "failed_verification", evidence };
  if (spec.visual) return { verdict: "needs_human_look", evidence };
  // Blind checks prove less than they claim: an unreadable stream caps the
  // verdict at unverifiable even when every mechanical check passed.
  if (!parserHealthy) return { verdict: "unverifiable", evidence };
  // Exit code alone proves nothing was checked; without a declared artifact or
  // a git effect the run can at best be unverifiable (SPEC: Verification).
  const substantive = checks.some((c) => c.applicable && c.name !== "exit_code" && c.name !== "parser_health");
  return { verdict: substantive ? "verified" : "unverifiable", evidence };
}
