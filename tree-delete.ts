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
import { DynamicBorder, TreeSelectorComponent } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, Text } from "@earendil-works/pi-tui";
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

  // Shared handler for both the /delete-subtree command and Ctrl+Delete shortcut.
  async function runDeleteSubtree(ctx: any): Promise<void> {
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

    // Unified action shape returned by the tree selector.
    interface DeleteAction {
      action: "delete" | "prune";
      entryId: string;
    }

    // Per-instance confirmation state shared between handleInput and render.
    interface ConfirmState {
      action: "delete" | "prune";
      entryId: string;
    }

    // Open the built-in tree selector.  Two destructive operations are
    // available:
    //   Ctrl+Delete  – delete the selected subtree
    //   Shift+Delete – prune everything EXCEPT the path to the selected entry
    const action = await ctx.ui.custom<DeleteAction | null>(
      (_tui: any, theme: any, _kb: any, done: any) => {
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

        // Rebrand to "Delete Session Tree" with red borders
        const selChildren = (selector as any).children as any[];
        for (let i = 0; i < selChildren.length; i++) {
          const child = selChildren[i];
          if (child instanceof Text && (child as any).render(80)[0]?.includes("Session Tree")) {
            selChildren[i] = new Text(
              theme.bold(theme.fg("error", "  Delete Session Tree")),
              1, 0,
            );
          } else if (child instanceof DynamicBorder) {
            selChildren[i] = new DynamicBorder((s: string) => theme.fg("error", s));
          }
        }

        const treeList = selector.getTreeList();
        const origHandleInput = treeList.handleInput.bind(treeList);

        let confirming: ConfirmState | null = null;

        // Patch handleInput
        treeList.handleInput = (keyData: string) => {
          if (confirming !== null) {
            if (
              keyData === "y" || keyData === "Y" ||
              matchesKey(keyData, Key.enter)
            ) {
              const payload: DeleteAction = {
                action: confirming.action,
                entryId: confirming.entryId,
              };
              confirming = null;
              done(payload);
              return;
            }
            if (
              matchesKey(keyData, Key.escape) ||
              keyData === "n" || keyData === "N"
            ) {
              confirming = null;
              _tui.requestRender();
              return;
            }
            return; // Block all other keys during confirmation
          }

          // Ctrl+Delete → delete subtree
          if (matchesKey(keyData, Key.ctrl("delete"))) {
            const selected = treeList.getSelectedNode();
            if (selected) {
              confirming = { action: "delete", entryId: selected.entry.id };
              _tui.requestRender();
            }
            return;
          }

          // Shift+Delete → prune to selected path (keep only this branch)
          if (matchesKey(keyData, Key.shift("delete"))) {
            const selected = treeList.getSelectedNode();
            if (selected) {
              confirming = { action: "prune", entryId: selected.entry.id };
              _tui.requestRender();
            }
            return;
          }

          // Normal tree navigation
          origHandleInput(keyData);
        };

        // Patch render
        const origRender = treeList.render.bind(treeList);
        treeList.render = (width: number): string[] => {
          const lines = origRender(width);
          if (confirming !== null) {
            lines.push(
              theme.fg("warning",
                "  " + "─".repeat(Math.max(20, width - 20))),
            );
            if (confirming.action === "delete") {
              lines.push(
                theme.bold(theme.fg("warning", "  DELETE")) +
                  theme.fg("muted", " this subtree?") +
                  "  " +
                  theme.fg("success", "[y/Enter]") +
                  theme.fg("muted", " confirm") +
                  "  " +
                  theme.fg("error", "[Esc/n]") +
                  theme.fg("muted", " cancel"),
              );
            } else {
              lines.push(
                theme.bold(theme.fg("warning", "  PRUNE")) +
                  theme.fg("muted", " — keep only Root → this entry, delete all other branches?") +
                  "  " +
                  theme.fg("success", "[y/Enter]") +
                  theme.fg("muted", " confirm") +
                  "  " +
                  theme.fg("error", "[Esc/n]") +
                  theme.fg("muted", " cancel"),
              );
            }
          } else {
            lines.push(
              theme.fg("dim",
                "  Ctrl+Delete delete subtree  |  Shift+Delete keep only this path"),
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
    if (!action) {
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    // ── Execute ──────────────────────────────────────────────
    try {
      if (action.action === "delete") {
        // ── Delete subtree ───────────────────────────────────
        const oldLeafId = sm.getLeafId();
        const result: RemoveSubtreeResult = sm.removeSubtree(action.entryId);
        const newLeafId = sm.getLeafId();

        if (oldLeafId && result.removedIds.includes(oldLeafId)) {
          if (newLeafId) {
            if (typeof (ctx as any).navigateTree === "function") {
              await (ctx as any).navigateTree(newLeafId, { summarize: false });
            }
            ctx.ui.notify(
              `Deleted ${result.removedIds.length} entries, moved to nearest surviving entry`,
              "info",
            );
          } else {
            ctx.ui.notify(
              `Deleted ${result.removedIds.length} entries (current position was removed)`,
              "warning",
            );
          }
        } else {
          ctx.ui.notify(`Deleted ${result.removedIds.length} entries`, "info");
        }

        gcSnapshotRepo(pi, ctx.cwd, result.removedCheckpoints, sm).catch(() => {});
      } else {
        // ── Prune to selected path ────────────────────────────
        // Build the path from root to the selected entry
        const path: string[] = [];
        let cursor: string | null = action.entryId;
        while (cursor) {
          path.unshift(cursor);
          const entry = sm.getEntry(cursor);
          cursor = entry?.parentId ?? null;
        }
        const pathSet = new Set(path);

        // Collect sibling subtrees at every level that are NOT on the path,
        // plus all children of the selected entry (make it a leaf).
        const otherRoots: string[] = [];
        for (const pathEntryId of path) {
          const entry = sm.getEntry(pathEntryId);
          if (!entry) continue;

          if (entry.parentId) {
            const siblings = sm.getChildren(entry.parentId);
            for (const sibling of siblings) {
              if (!pathSet.has(sibling.id)) {
                otherRoots.push(sibling.id);
              }
            }
          } else {
            // Root entry – also remove other root-level siblings
            const currentTree = sm.getTree();
            for (const root of currentTree) {
              if (!pathSet.has(root.entry.id)) {
                otherRoots.push(root.entry.id);
              }
            }
          }
        }

        // Also remove all children of the selected entry (prune its descendants)
        const selectedChildren = sm.getChildren(action.entryId);
        for (const child of selectedChildren) {
          otherRoots.push(child.id);
        }

        // Delete every off-path subtree
        let totalRemoved = 0;
        const allCheckpoints: CheckpointData[] = [];
        for (const rootId of otherRoots) {
          try {
            const r: RemoveSubtreeResult = sm.removeSubtree(rootId);
            totalRemoved += r.removedIds.length;
            allCheckpoints.push(...r.removedCheckpoints);
          } catch {
            // Entry may have already been removed by a previous iteration
          }
        }

        // Navigate to the selected entry if we aren't already there
        const currentLeaf = sm.getLeafId();
        if (currentLeaf !== action.entryId) {
          if (typeof (ctx as any).navigateTree === "function") {
            await (ctx as any).navigateTree(action.entryId, { summarize: false });
          }
        }

        ctx.ui.notify(
          `Pruned to selected path — removed ${totalRemoved} entries from ${otherRoots.length} other branch(es)`,
          "info",
        );

        gcSnapshotRepo(pi, ctx.cwd, allCheckpoints, sm).catch(() => {});
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.ui.notify(`Operation failed: ${msg}`, "error");
    }
  }

  pi.registerCommand("delete-subtree", {
    description: "Delete a subtree from the session tree",
    handler: async (_args, ctx) => {
      await runDeleteSubtree(ctx);
    },
  });

  pi.registerShortcut("ctrl+delete", {
    description: "Delete subtree",
    handler: async (ctx) => {
      await runDeleteSubtree(ctx);
    },
  });
}
