import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { ExitStatus, Run } from "./types.ts";

export type PruneStatus = "safe" | "dirty" | "unintegrated" | "not_git" | "missing" | "active";

export interface PruneCandidate {
  run: Run;
  status: PruneStatus;
  sizeBytes: number | null;
  detail: string;
}

const TERMINAL: ExitStatus[] = ["succeeded", "failed", "killed", "lost"];

function dirSizeBytes(path: string): number | null {
  const r = spawnSync("du", ["-sk", path], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const kb = Number(r.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/**
 * The main working tree registered against the same repository as `workdir`
 * (a linked worktree created by `git worktree add`). `worktree list
 * --porcelain` enumerates every worktree of the repository regardless of
 * which one it's run from - the first record is always the main tree, so
 * this works whether `workdir` is itself a linked worktree or (defensively)
 * already the main one.
 */
function mainWorktreePath(workdir: string): string | null {
  const r = spawnSync("git", ["-C", workdir, "worktree", "list", "--porcelain"], { encoding: "utf8" });
  if (r.status !== 0) return null;
  const first = r.stdout.split("\n\n")[0] ?? "";
  const line = first.split("\n").find((l) => l.startsWith("worktree "));
  return line ? line.slice("worktree ".length).trim() : null;
}

/**
 * Whether a run's worktree checkout can be reclaimed without losing anything
 * - i.e. every byte of it is already recoverable from the source repo's own
 * history, so deleting the checkout destroys no information that doesn't
 * already exist elsewhere. Two conditions, BOTH required:
 *
 *   - clean tree: a run can leave real, valuable output UNCOMMITTED and
 *     still pass verification - `git_effect` (verify.ts) treats a dirty tree
 *     as evidence of effect for exactly this reason (fleet evidence: clean-
 *     committing runs were once wrongly failed for the opposite case). A
 *     dirty worktree's HEAD trivially equals the source repo's HEAD (no new
 *     commits were ever made), so ancestry alone would call it "integrated"
 *     while it's actually the only copy of that work.
 *   - HEAD reachable from the source repo's current tip: commits made in the
 *     worktree that were never merged or pushed anywhere else are real,
 *     un-backed-up work; ancestry is the only mechanical proof they're not.
 *
 * A run still `active` (queued/running) is never evaluated against the
 * filesystem at all - its worktree must never be touched regardless of what
 * ancestry would say about a stale read mid-flight.
 */
export function evaluateWorktree(run: Run): PruneCandidate {
  const workdir = run.workdir;
  if (!TERMINAL.includes(run.exit)) {
    return { run, status: "active", sizeBytes: null, detail: `exit=${run.exit}, not terminal` };
  }
  if (!existsSync(workdir)) {
    return { run, status: "missing", sizeBytes: null, detail: "already gone" };
  }
  const isGit = spawnSync("git", ["-C", workdir, "rev-parse", "--git-dir"], { stdio: "ignore" }).status === 0;
  const size = dirSizeBytes(workdir);
  if (!isGit) {
    return { run, status: "not_git", sizeBytes: size, detail: "not a git worktree (fresh non-git workdir) - nothing else holds this" };
  }
  const status = spawnSync("git", ["-C", workdir, "status", "--porcelain"], { encoding: "utf8" });
  const dirty = status.status !== 0 || status.stdout.trim().length > 0;
  if (dirty) {
    return { run, status: "dirty", sizeBytes: size, detail: "uncommitted changes - nothing else holds this work" };
  }
  const head = spawnSync("git", ["-C", workdir, "rev-parse", "HEAD"], { encoding: "utf8" });
  const headSha = head.status === 0 ? head.stdout.trim() : null;
  const mainRepo = mainWorktreePath(workdir);
  if (!headSha || !mainRepo) {
    return { run, status: "unintegrated", sizeBytes: size, detail: "could not determine source repo/HEAD" };
  }
  const ancestor = spawnSync("git", ["-C", mainRepo, "merge-base", "--is-ancestor", headSha, "HEAD"]).status === 0;
  if (!ancestor) {
    return {
      run,
      status: "unintegrated",
      sizeBytes: size,
      detail: `HEAD ${headSha.slice(0, 7)} not reachable from ${mainRepo}'s current HEAD`,
    };
  }
  return { run, status: "safe", sizeBytes: size, detail: `clean, HEAD ${headSha.slice(0, 7)} integrated into ${mainRepo}` };
}

/**
 * Reclaim a `safe`-status worktree's checkout only - the run's ledger row,
 * spec.json, and event history (outside `work/`) are untouched, so `mc show`
 * keeps working forever. No `--force`: git's own dirty-tree refusal is a
 * second, independent check beyond evaluateWorktree's own - defense in depth
 * against a stale read racing a concurrent write.
 */
export function pruneWorktree(candidate: PruneCandidate): { removed: boolean; error?: string } {
  if (candidate.status !== "safe") {
    return { removed: false, error: `refusing: status is "${candidate.status}", not "safe"` };
  }
  const workdir = candidate.run.workdir;
  const mainRepo = mainWorktreePath(workdir);
  if (!mainRepo) return { removed: false, error: "could not resolve the source repo to deregister the worktree" };
  const r = spawnSync("git", ["-C", mainRepo, "worktree", "remove", workdir], { encoding: "utf8" });
  if (r.status !== 0) return { removed: false, error: r.stderr?.trim() || "git worktree remove failed" };
  return { removed: true };
}
