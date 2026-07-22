/**
 * Tree Delete Extension
 *
 * Adds subtree deletion to the session tree via the `/delete-subtree` command.
 * Reuses the built-in TreeSelectorComponent UI with an instance-level
 * monkey-patch for the `d` key (delete) with inline confirmation.
 *
 * Also monkey-patches SessionManager.prototype.removeSubtree on first
 * load if the core lacks it, and cleans up orphaned git snapshot objects
 * after deletion.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TreeSelectorComponent } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { homedir } from "node:os";

// ── Types ───────────────────────────────────────────────────────────

interface CheckpointData {
  entryId: string;
  stashRef: string;
}

interface RemoveSubtreeResult {
  removedIds: string[];
  removedCheckpoints: CheckpointData[];
}

let patched = false;

// ── Monkey-patch SessionManager.prototype.removeSubtree ─────────────

function ensureRemoveSubtree(sessionManager: any): boolean {
  const proto = Object.getPrototypeOf(sessionManager);
  if (typeof proto.removeSubtree === "function") return true;

  try {
    proto.removeSubtree = function (this: any, entryId: string): RemoveSubtreeResult {
      if (!this.byId.has(entryId)) {
        throw new Error(`Entry not found: ${entryId}`);
      }

      const parentMap = new Map<string, string | null>();
      for (const entry of this.fileEntries) {
        if (entry.type !== "session") {
          parentMap.set(entry.id, entry.parentId);
        }
      }

      const removedSet = new Set<string>();
      const queue = [entryId];
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (removedSet.has(current)) continue;
        removedSet.add(current);
        for (const child of this.getChildren(current)) {
          queue.push(child.id);
        }
      }

      const removedCheckpoints: CheckpointData[] = [];
      for (const entry of this.fileEntries) {
        if (
          removedSet.has(entry.id) &&
          entry.type === "custom" &&
          entry.customType === "tree-git-checkpoint"
        ) {
          const data = entry.data as CheckpointData | undefined;
          if (data?.entryId && data?.stashRef) {
            removedCheckpoints.push({ entryId: data.entryId, stashRef: data.stashRef });
          }
        }
      }

      if (this.leafId && removedSet.has(this.leafId)) {
        let cursor: string | null = this.leafId;
        while (cursor && removedSet.has(cursor)) {
          cursor = parentMap.get(cursor) ?? null;
        }
        this.leafId = cursor;
      }

      this.fileEntries = this.fileEntries.filter(
        (e: any) => !removedSet.has(e.id) || e.type === "session",
      );

      for (const id of removedSet) {
        this.byId.delete(id);
        this.labelsById.delete(id);
        this.labelTimestampsById.delete(id);
      }

      this._rewriteFile();

      return { removedIds: [...removedSet], removedCheckpoints };
    };

    return true;
  } catch (_err) {
    return false;
  }
}

// ── Snapshot GC ─────────────────────────────────────────────────────

function getSnapshotRepoPath(cwd: string): string {
  const encoded = `--${cwd.replace(/\//g, "-").replace(/^-/, "")}--`;
  return join(homedir(), ".pi", "agent", "snapshots", encoded);
}

async function gcSnapshotRepo(
  pi: ExtensionAPI,
  cwd: string,
  removedCheckpoints: CheckpointData[],
  sessionManager: any,
): Promise<void> {
  if (removedCheckpoints.length === 0) return;

  const snapshotGitDir = getSnapshotRepoPath(cwd);
  const sessionId = sessionManager.getSessionId();
  const indexFile = join(snapshotGitDir, `index-${sessionId}`);

  const git = async (cmd: string) =>
    pi.exec("bash", ["-c",
      `GIT_INDEX_FILE=${indexFile} git --git-dir=${snapshotGitDir} --work-tree=${cwd} ${cmd}`,
    ]);
  const gitCode = async (cmd: string) => (await git(cmd)).code;

  const { code: existsCode } = await pi.exec("git", [
    "--git-dir", snapshotGitDir, "rev-parse", "--git-dir",
  ]);
  if (existsCode !== 0) return;

  const survivingHashes = new Set<string>();
  for (const entry of sessionManager.getEntries()) {
    if (entry.type === "custom" && entry.customType === "tree-git-checkpoint") {
      const data = entry.data as CheckpointData | undefined;
      if (data?.stashRef) survivingHashes.add(data.stashRef);
    }
  }

  if (survivingHashes.size === 0) {
    await gitCode("gc --prune=now");
    return;
  }

  const refPrefix = "refs/pi-checkpoints/";
  for (const hash of survivingHashes) {
    await gitCode(`update-ref ${refPrefix}${hash} ${hash}`);
  }
  await gitCode("gc --prune=now");
  for (const hash of survivingHashes) {
    await gitCode(`update-ref -d ${refPrefix}${hash}`);
  }
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (patched) return;
    const sm = ctx.sessionManager as any;
    if (!sm) return;
    if (ensureRemoveSubtree(sm)) {
      patched = true;
    } else {
      ctx.ui.notify(
        "tree-delete: Failed to patch SessionManager — extension disabled",
        "error",
      );
    }
  });

  pi.registerCommand("delete-subtree", {
    description: "Delete a subtree from the session tree",
    handler: async (_args, ctx) => {
      const sm = ctx.sessionManager as any;
      if (!patched && !ensureRemoveSubtree(sm)) {
        ctx.ui.notify("tree-delete: patch failed", "error");
        return;
      }
      patched = true;

      if (!ctx.hasUI) {
        ctx.ui.notify("This command requires TUI mode", "warning");
        return;
      }

      const tree = sm.getTree();
      if (tree.length === 0) {
        ctx.ui.notify("No entries in session", "info");
        return;
      }

      const realLeafId = sm.getLeafId();

      // Open the built-in tree selector, monkey-patched per-instance
      // with 'd' for delete + inline confirmation.
      // Returns the entryId to delete, or null if user cancelled.
      const entryIdToDelete = await ctx.ui.custom<string | null>(
        (_tui, theme, _kb, done) => {
          const selector = new TreeSelectorComponent(
            tree,
            realLeafId,
            _tui.terminal.rows,
            /* onSelect */ (_eid: string) => { /* Enter does nothing */ },
            /* onCancel */ () => done(null),
            /* onLabelChange */ undefined,
            /* initialSelectedId */ undefined,
            /* initialFilterMode */ "default",
          );

          const treeList = selector.getTreeList();
          const origHandleInput = treeList.handleInput.bind(treeList);

          // Per-instance delete confirmation state
          let confirmingDelete: string | null = null;

          // Patch handleInput
          treeList.handleInput = (keyData: string) => {
            if (confirmingDelete !== null) {
              if (keyData === "y" || keyData === "Y") {
                const entryId = confirmingDelete;
                confirmingDelete = null;
                done(entryId);
                return;
              }
              if (
                matchesKey(keyData, Key.escape) ||
                keyData === "n" || keyData === "N"
              ) {
                confirmingDelete = null;
                _tui.requestRender();
                return;
              }
              return; // Block all other keys during confirmation
            }

            // Ctrl+Delete → enter delete confirmation
            if (matchesKey(keyData, Key.ctrl("delete"))) {
              const selected = treeList.getSelectedNode();
              if (selected) {
                confirmingDelete = selected.entry.id;
                _tui.requestRender();
              }
              return;
            }

            // Normal tree navigation
            origHandleInput(keyData);
          };

          // Patch render to show delete hint + confirmation bar
          const origRender = treeList.render.bind(treeList);
          treeList.render = (width: number): string[] => {
            const lines = origRender(width);
            if (confirmingDelete !== null) {
              lines.push(
                theme.fg("warning",
                  "  " + "─".repeat(Math.max(20, width - 20))),
              );
              lines.push(
                theme.bold(theme.fg("warning", "  DELETE")) +
                  theme.fg("muted", " this subtree?") +
                  "  " +
                  theme.fg("success", "[y]") +
                  theme.fg("muted", " confirm") +
                  "  " +
                  theme.fg("error", "[Esc/n]") +
                  theme.fg("muted", " cancel"),
              );
            } else {
              // Show Ctrl+Delete hint at the bottom when not confirming
              lines.push(
                theme.fg("dim",
                  "  Ctrl+Delete to delete the selected entry"),
              );
            }
            return lines;
          };

          return {
            render: (w: number) => selector.render(w),
            invalidate: () => selector.invalidate(),
            handleInput: (data: string) => {
              treeList.handleInput(data);
              _tui.requestRender();
            },
          };
        },
      );

      // After tree selector closes
      if (!entryIdToDelete) {
        ctx.ui.notify("Cancelled", "info");
        return;
      }

      // Execute deletion
      try {
        const result: RemoveSubtreeResult = sm.removeSubtree(entryIdToDelete);
        ctx.ui.notify(`Deleted ${result.removedIds.length} entries`, "info");
        // Background: clean up snapshot git objects
        gcSnapshotRepo(pi, ctx.cwd, result.removedCheckpoints, sm).catch(() => {});
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`Delete failed: ${msg}`, "error");
      }
    },
  });
}
