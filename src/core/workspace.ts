import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runDir } from "./config.ts";
import { PreflightError } from "./types.ts";

/** Paths a run must never be pointed at (agent-state clobbering class of bug). */
function forbiddenRoots(): string[] {
  const home = homedir();
  return [
    join(home, ".claude"),
    join(home, ".codex"),
    join(home, ".kimi-code"),
    join(home, ".kimi"), // legacy kimi-cli data root
    join(home, ".local", "share", "opencode"), // auth.json + session sqlite db
    join(home, ".config", "opencode"), // opencode.json, agents/commands
    join(home, ".pi"),
    join(home, ".openclaw"),
    join(home, ".mission-control"),
  ];
}

export function createWorkdir(id: string, sourceCwd: string | null): { workdir: string; isGit: boolean } {
  const dir = runDir(id);
  mkdirSync(dir, { recursive: true });
  const workdir = join(dir, "work");

  if (sourceCwd) {
    const abs = resolve(sourceCwd);
    for (const root of forbiddenRoots()) {
      if (abs === root || abs.startsWith(root + "/")) {
        throw new PreflightError(`refusing to run inside agent-state directory ${root}`);
      }
    }
    const isRepo = spawnSync("git", ["-C", abs, "rev-parse", "--git-dir"], { stdio: "ignore" }).status === 0;
    if (!isRepo) {
      // Silently launching with an EMPTY workdir would hide the task's inputs.
      throw new PreflightError(
        `--cwd ${abs} is not a git repository; v0's isolation model is git-worktree-based. ` +
          `Run \`git init\` there first, or omit --cwd for a fresh empty workdir.`,
      );
    }
    const wt = spawnSync("git", ["-C", abs, "worktree", "add", "--detach", workdir], {
      encoding: "utf8",
    });
    if (wt.status !== 0) {
      throw new PreflightError(`git worktree add failed: ${wt.stderr?.trim()}`);
    }
    return { workdir, isGit: true };
  }

  mkdirSync(workdir, { recursive: true });
  return { workdir, isGit: false };
}

/**
 * Checkpoint restart (mc resume --fresh): a NEW detached worktree at a commit
 * of the parent run's repo. The tracked replacement for the hand-rolled
 * `git worktree add` operators used to escape stuck sessions.
 */
export function createWorkdirFromCheckpoint(
  id: string,
  parentWorkdir: string,
  at: string | null,
): { workdir: string; checkpoint: string } {
  const dir = runDir(id);
  mkdirSync(dir, { recursive: true });
  const workdir = join(dir, "work");

  const ref = at ?? "HEAD";
  const resolved = spawnSync("git", ["-C", parentWorkdir, "rev-parse", "--verify", `${ref}^{commit}`], {
    encoding: "utf8",
  });
  if (resolved.status !== 0) {
    throw new PreflightError(
      `checkpoint "${ref}" is not a commit in the parent run's workdir (${resolved.stderr?.trim() || "rev-parse failed"})`,
    );
  }
  const checkpoint = resolved.stdout.trim();
  const wt = spawnSync("git", ["-C", parentWorkdir, "worktree", "add", "--detach", workdir, checkpoint], {
    encoding: "utf8",
  });
  if (wt.status !== 0) {
    throw new PreflightError(`git worktree add failed: ${wt.stderr?.trim()}`);
  }
  return { workdir, checkpoint };
}
