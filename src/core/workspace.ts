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
