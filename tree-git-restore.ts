/**
 * Tree Git Restore Extension
 *
 * When using /tree to navigate to a previous conversation state, files in
 * the working directory are automatically restored to match the state at
 * that conversation point.
 *
 * Design (inspired by OpenCode's snapshot module):
 * 1. A standalone bare git repo is maintained at
 *    ~/.pi/agent/snapshots/--<path>--/ — completely independent from
 *    the user's own git repo.
 * 2. Before each AI turn (turn_start), `git add --all` + `git write-tree`
 *    creates a tree hash that captures ALL files in the working directory
 *    (including untracked / newly-created files).
 * 3. When /tree navigation completes (session_tree), the snapshot tree is
 *    restored via `git read-tree` + `git checkout-index -a -f`, which
 *    writes every file back to the working directory.
 * 4. Snapshot hashes are persisted in the session via pi.appendEntry so
 *    they survive /reload.
 * 5. On shutdown, `git gc --prune=7.days` runs to bound disk usage.
 *
 * Snapshot is only active when the working directory is inside a git
 * repo (checked via `git rev-parse --git-dir`).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text, Spacer } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { homedir } from "node:os";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";


interface CheckpointData {
  entryId: string;
  stashRef: string;
}

export default function (pi: ExtensionAPI) {
  // Map from session entry ID → git tree hash
  const checkpoints = new Map<string, string>();
  let snapshotGitDir = "";
  let indexFile = "";
  let worktree = "";
  let enabled = false;

  /**
   * Run a git command against the snapshot repo with this session's
   * private index file so concurrent sessions don't conflict.
   */
  const git = async (cmd: string) =>
    pi.exec("bash", [
      "-c",
      `GIT_INDEX_FILE=${indexFile} git --git-dir=${snapshotGitDir} --work-tree=${worktree} ${cmd}`,
    ]);

  /** Same as git() but returns only exit code (for fire-and-forget). */
  const gitCode = async (cmd: string) => (await git(cmd)).code;

  // ── session_start: init snapshot repo & restore persisted checkpoints ──

  pi.on("session_start", async (_event, ctx) => {
    // Only enable snapshots inside a git repo (same as OpenCode).
    // This avoids accidentally snapshotting large non-project directories.
    const { code: revParseCode } = await pi.exec("git", ["rev-parse", "--git-dir"]);
    if (revParseCode !== 0) return;

    worktree = ctx.cwd;
    // Use the same path-encoding scheme as pi sessions: replace / with -
    // so /home/y/project becomes --home-y-project--
    const encoded = `--${worktree.replace(/\//g, "-").replace(/^-/, "")}--`;
    snapshotGitDir = join(homedir(), ".pi", "agent", "snapshots", encoded);

    // Create bare git repo (idempotent — safe to call on existing repo)
    const { code: initCode } = await pi.exec("git", [
      "init",
      "--bare",
      "--initial-branch=s",
      snapshotGitDir,
    ]);
    if (initCode !== 0) return;

    // Configure for cross-platform reliability
    for (const [k, v] of [
      ["core.longpaths", "true"],
      ["core.symlinks", "true"],
      ["core.autocrlf", "false"],
      ["gc.auto", "100"],
      ["gc.pruneExpire", "7.days"],
    ]) {
      await pi.exec("git", ["--git-dir", snapshotGitDir, "config", k, v]);
    }

    // Exclude common large / generated directories so we never
    // accidentally snapshot an entire home directory or node_modules.
    const infoDir = join(snapshotGitDir, "info");
    if (!existsSync(infoDir)) mkdirSync(infoDir, { recursive: true });
    writeFileSync(
      join(infoDir, "exclude"),
      [
        ".git",
        "node_modules",
        "__pycache__",
        "*.pyc",
        ".venv",
        "venv",
        ".env",
        ".next",
        "dist",
        "build",
        "target",
        ".cache",
        ".npm",
        ".yarn",
        ".pnpm-store",
        ".pytest_cache",
        ".mypy_cache",
        ".ruff_cache",
      ].join("\n") + "\n",
    );

    // Give each session its own index file so concurrent sessions on
    // the same worktree don't clobber each other.  Object storage is
    // shared (safe — content-addressed) but the index is mutable.
    const sessionId = ctx.sessionManager.getSessionId();
    indexFile = join(snapshotGitDir, `index-${sessionId}`);

    enabled = true;

    // Restore persisted checkpoints from session
    checkpoints.clear();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "tree-git-checkpoint") {
        const data = entry.data as CheckpointData | undefined;
        if (data?.entryId && data?.stashRef) {
          checkpoints.set(data.entryId, data.stashRef);
        }
      }
    }
  });

  // ── turn_start: clear widget & snapshot working tree before AI makes changes ──

  pi.on("turn_start", async (_event, ctx) => {
    // Clear the /tree restore widget from the previous session_tree
    ctx.ui.setWidget("tree-restore", undefined);

    if (!enabled) return;

    const leaf = ctx.sessionManager.getLeafEntry();
    if (!leaf || checkpoints.has(leaf.id)) return;

    // Stage changed files from the worktree (tracked + untracked).
    // The exclude file above protects against node_modules etc.
    if ((await gitCode("add --all")) !== 0) return;

    // Guard: if the staged file count is huge, the worktree is probably
    // too large for snapshots (e.g. running pi from $HOME). Abort.
    const { stdout: countOut } = await git("ls-files --cached");
    const fileCount = countOut.split("\n").filter(Boolean).length;
    if (fileCount > 50000) {
      // Reset the index and skip this snapshot
      await gitCode("read-tree --empty");
      return;
    }

    // Write a tree object and get its hash
    const { stdout, code: writeCode } = await git("write-tree");
    if (writeCode !== 0 || !stdout.trim()) return;

    const hash = stdout.trim();
    checkpoints.set(leaf.id, hash);
    pi.appendEntry("tree-git-checkpoint", { entryId: leaf.id, stashRef: hash });
  });

  // ── session_tree: restore files when /tree navigation completes ──

  pi.on("session_tree", async (event, ctx) => {
    if (!enabled) return;

    const ref = findNearestCheckpoint(event.newLeafId, ctx);
    if (!ref) return;

    // Capture the old tree hash from the current index (state before restore)
    // so we can diff against the restored tree.
    const { stdout: oldTreeStr } = await git("write-tree");
    const oldTree = oldTreeStr.trim();

    // Load the snapshot tree and force-write to working tree
    if ((await gitCode(`read-tree ${ref}`)) !== 0) return;
    await gitCode("checkout-index -a -f");

    // Compute diff in git pull style: diff-tree --stat
    let diffStat = "";
    if (oldTree && oldTree !== ref) {
      const { stdout } = await git(`diff-tree --stat ${oldTree} ${ref}`);
      diffStat = stdout;
    }

    // Show file change summary as a widget below the editor,
    // styled like the built-in "Update Available" notification bar
    // (DynamicBorder + bold title + content + DynamicBorder).
    // It persists until the next AI turn starts, so the user can
    // review changes at their own pace before continuing.
    if (ctx.hasUI) {
      ctx.ui.setWidget("tree-restore", (_tui, theme) => {
        const container = new Container();

        // Empty line + top border ── (like DynamicBorder with warning color)
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("warning", "─".repeat(50)), 0, 0));

        // Bold title in warning color
        container.addChild(new Text(theme.bold(theme.fg("warning", "📂 /tree 文件恢复")), 1, 0));

        if (diffStat) {
          const rawLines = diffStat.trimEnd().split("\n");
          for (const line of rawLines) {
            const trimmed = line.trimEnd();
            // Summary line like "3 files changed, 42 insertions(+), 10 deletions(-)"
            if (/^\d+ file/.test(trimmed)) {
              container.addChild(new Text(theme.fg("accent", trimmed), 1, 0));
            } else {
              container.addChild(new Text(theme.fg("toolOutput", trimmed), 1, 0));
            }
          }
        } else {
          container.addChild(new Text(theme.fg("dim", "  (无文件变更)"), 1, 0));
        }

        // Bottom border ──
        container.addChild(new Text(theme.fg("warning", "─".repeat(50)), 0, 0));

        return container;
      }, { placement: "belowEditor" });

      ctx.ui.notify("📂 文件已恢复，详情见编辑器下方", "info");
    }
  });

  // ── session_shutdown: nothing to do (gc.auto handles cleanup) ──

  // ── helpers ─────────────────────────────────────────────────────────

  /**
   * Walk up the parent chain from `entryId` to find the closest
   * ancestor (or the entry itself) that has a checkpoint.
   */
  function findNearestCheckpoint(
    entryId: string,
    ctx: ExtensionContext,
  ): string | undefined {
    if (checkpoints.has(entryId)) return checkpoints.get(entryId);

    const entries = ctx.sessionManager.getEntries();
    const entryMap = new Map<string, { parentId?: string }>();
    for (const e of entries) {
      entryMap.set(e.id, e as unknown as { parentId?: string });
    }

    let current = entryMap.get(entryId);
    while (current) {
      if (current.parentId) {
        const parentCheckpoint = checkpoints.get(current.parentId);
        if (parentCheckpoint) return parentCheckpoint;
        current = entryMap.get(current.parentId);
      } else {
        break;
      }
    }

    return undefined;
  }
}
