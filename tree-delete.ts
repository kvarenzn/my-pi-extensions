/**
 * Tree Delete Extension
 *
 * Adds subtree deletion to the session tree via the `/delete-subtree` command
 * and the Ctrl+Delete shortcut.  Reuses the built-in TreeSelectorComponent with
 * a per-instance monkey-patch of its TreeList for the destructive keys:
 *
 *   Ctrl+Delete  – delete the selected subtree (inline confirmation)
 *   Shift+Delete – prune: keep only the path Root → selected entry, delete all
 *                  other branches and the selected entry's children
 *
 * Implementation notes:
 * - SessionManager.prototype.removeSubtree is monkey-patched on first load only
 *   if the core lacks it (pi ≤ 0.84.2 does).  The patch keeps the session
 *   header, repositions the leaf to the nearest surviving ancestor, and
 *   rewrites the session file.
 * - All mutation code is shape-independent: the removed set is computed up
 *   front via public SessionManager methods, so a future core removeSubtree
 *   with a different return shape cannot break deletion, navigation or GC.
 * - Deletion is refused while the agent is streaming (mirrors the core's
 *   navigateTree guard).
 * - Command ctxs expose ctx.navigateTree (chat refresh + status).  Shortcut
 *   handlers receive a reduced ctx without it (pi ≤ 0.84.2), so a manual
 *   fallback repositions the leaf and editor and warns that the chat pane
 *   refreshes on the next full rebuild.
 * - Snapshot GC: after deleting tree-git-checkpoint entries their git objects
 *   are pruned from the shared per-worktree snapshot repo.  Because the repo is
 *   shared by ALL sessions of the worktree, every checkpoint hash referenced by
 *   this session AND by sibling session files is protected with a temporary ref
 *   while `git gc --prune=now` runs.  If sibling files cannot be scanned, it
 *   falls back to the restore extension's 7-day retention policy instead of
 *   hard-pruning blind.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, TreeSelectorComponent } from "@earendil-works/pi-coding-agent";
import { matchesKey, Key, Text } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { homedir } from "node:os";
import { readdir, readFile } from "node:fs/promises";

// ── Types ───────────────────────────────────────────────────────────

interface CheckpointData {
  entryId: string;
  stashRef: string;
}

interface RemovedSubtree {
  removedIds: string[];
  removedCheckpoints: CheckpointData[];
}

let patched = false;

// ── Small helpers ───────────────────────────────────────────────────

/** The subset of the extension context this extension relies on. */
interface ExtensionCtx {
  sessionManager: any;
  hasUI: boolean;
  cwd: string;
  isIdle?: () => boolean;
  navigateTree?: (targetId: string, options?: { summarize?: boolean }) => Promise<unknown>;
  ui: {
    custom<T>(factory: (...args: any[]) => any): Promise<T>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setEditorText(text: string): void;
    getEditorText(): string;
  };
}

/** Extract plain text from message content (string or content blocks). */
function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c && c.type === "text")
      .map((c: any) => c.text ?? "")
      .join("");
  }
  return "";
}

/** Editor-visible text of an entry, if it behaves like a user message. */
function entryText(entry: any): string | undefined {
  if (!entry) return undefined;
  if (entry.type === "custom_message") return extractMessageText(entry.content);
  if (entry.type === "message" && entry.message?.role === "user") {
    return extractMessageText(entry.message.content);
  }
  return undefined;
}

function isUserLikeEntry(entry: any): boolean {
  return (
    entry !== undefined &&
    (entry.type === "custom_message" ||
      (entry.type === "message" && entry.message?.role === "user"))
  );
}

/**
 * Compute the subtree rooted at `entryId` (ids + contained checkpoints) using
 * only public SessionManager methods, so callers never depend on the return
 * shape of removeSubtree().
 */
function computeRemovedSubtree(sm: any, entryId: string): RemovedSubtree {
  if (!sm.getEntry(entryId)) {
    throw new Error(`Entry not found: ${entryId}`);
  }
  const removedIds: string[] = [];
  const seen = new Set<string>();
  const queue = [entryId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    removedIds.push(current);
    for (const child of sm.getChildren(current)) {
      queue.push(child.id);
    }
  }
  const removedCheckpoints: CheckpointData[] = [];
  for (const entry of sm.getEntries()) {
    if (
      seen.has(entry.id) &&
      entry.type === "custom" &&
      entry.customType === "tree-git-checkpoint"
    ) {
      const data = entry.data as CheckpointData | undefined;
      if (data?.entryId && data?.stashRef) {
        removedCheckpoints.push({ entryId: data.entryId, stashRef: data.stashRef });
      }
    }
  }
  return { removedIds, removedCheckpoints };
}

/**
 * If the current leaf was removed, move it to the nearest surviving ancestor
 * (or reset it when nothing survives).  Uses only public methods, so it also
 * repairs the state after a future core removeSubtree().
 */
function repairLeafAfterRemoval(sm: any, removedIds: string[]): void {
  const removed = new Set(removedIds);
  const leaf = sm.getLeafId();
  if (leaf === null || !removed.has(leaf)) return;
  let cursor: string | null = leaf;
  while (cursor && removed.has(cursor)) {
    const entry = sm.getEntry(cursor);
    cursor = entry?.parentId ?? null;
  }
  if (cursor) {
    try {
      sm.branch(cursor);
    } catch {
      /* keep current leaf */
    }
  } else {
    try {
      sm.resetLeaf();
    } catch {
      /* keep current leaf */
    }
  }
}

/**
 * Mirror the core's navigateTree leaf rule for user-like targets:
 * leaf = parentId (message text goes to the editor), else leaf = the entry
 * itself.  Used by the shortcut fallback (shortcut ctx has no navigateTree).
 */
function applyUserMessageLeafRule(sm: any, entryId: string | null): void {
  if (!entryId) return;
  const entry = sm.getEntry(entryId);
  if (!isUserLikeEntry(entry)) return;
  if (entry.parentId) {
    try {
      sm.branch(entry.parentId);
    } catch {
      /* keep current leaf */
    }
  } else {
    try {
      sm.resetLeaf();
    } catch {
      /* keep current leaf */
    }
  }
}

/** Text of the nearest user-like entry at or above `entryId` ("" if none). */
function nearestUserMessageText(sm: any, entryId: string | null): string {
  let cursor: string | null = entryId;
  while (cursor) {
    const text = entryText(sm.getEntry(cursor));
    if (text !== undefined) return text;
    const entry = sm.getEntry(cursor);
    cursor = entry?.parentId ?? null;
  }
  return "";
}

// ── Monkey-patch SessionManager.prototype.removeSubtree ─────────────

/**
 * Ensure SessionManager has removeSubtree.  If the core already provides one
 * (future pi versions), leave it alone.  Otherwise install a compatible patch.
 */
function ensureRemoveSubtree(sessionManager: any): {
  ok: boolean;
  patched: boolean;
  message?: string;
} {
  const proto = Object.getPrototypeOf(sessionManager);
  if (typeof proto.removeSubtree === "function") {
    return { ok: true, patched: false };
  }
  // Sanity-check the private internals the patch relies on, so a core refactor
  // fails loudly instead of corrupting the session file.
  if (
    !(sessionManager.byId instanceof Map) ||
    !Array.isArray(sessionManager.fileEntries) ||
    typeof sessionManager.getChildren !== "function" ||
    typeof sessionManager._rewriteFile !== "function"
  ) {
    return {
      ok: false,
      patched: false,
      message: "core SessionManager internals changed – patch not installed",
    };
  }
  try {
    proto.removeSubtree = function (this: any, entryId: string): RemovedSubtree {
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
    return { ok: true, patched: true };
  } catch (err) {
    return {
      ok: false,
      patched: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Snapshot GC ─────────────────────────────────────────────────────

function getSnapshotRepoPath(cwd: string): string {
  const encoded = `--${cwd.replace(/\//g, "-").replace(/^-/, "")}--`;
  return join(homedir(), ".pi", "agent", "snapshots", encoded);
}

/** Single-quote a string for safe shell embedding. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Prune git objects of deleted checkpoints from the shared per-worktree
 * snapshot repo.  The repo is shared by ALL sessions of this worktree, so
 * before `git gc --prune=now` every checkpoint hash referenced by this session
 * OR by any sibling session file is protected with a temporary ref.  If sibling
 * files can't be scanned, fall back to the restore extension's 7-day policy
 * instead of hard-pruning blind.
 */
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
    pi.exec("bash", [
      "-c",
      `GIT_INDEX_FILE=${shq(indexFile)} git --git-dir=${shq(snapshotGitDir)} --work-tree=${shq(cwd)} ${cmd}`,
    ]);
  const gitCode = async (cmd: string) => (await git(cmd)).code;

  const { code: existsCode } = await pi.exec("git", [
    "--git-dir", snapshotGitDir, "rev-parse", "--git-dir",
  ]);
  if (existsCode !== 0) return;

  // Collect every checkpoint hash we can see: this session's entries plus all
  // sibling session files (same worktree ⇒ same snapshot repo).
  const survivingHashes = new Set<string>();
  const collectFromEntries = (entries: any[]) => {
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "tree-git-checkpoint") {
        const data = entry.data as CheckpointData | undefined;
        if (data?.stashRef) survivingHashes.add(data.stashRef);
      }
    }
  };
  collectFromEntries(sessionManager.getEntries());

  let scanOk = false;
  const encoded = `--${cwd.replace(/\//g, "-").replace(/^-/, "")}--`;
  const sessionsDir = join(homedir(), ".pi", "agent", "sessions", encoded);
  try {
    const files = await readdir(sessionsDir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      try {
        const content = await readFile(join(sessionsDir, file), "utf8");
        for (const line of content.split("\n")) {
          if (!line.includes("tree-git-checkpoint")) continue;
          try {
            const entry = JSON.parse(line);
            if (
              entry?.type === "custom" &&
              entry.customType === "tree-git-checkpoint"
            ) {
              const data = entry.data as CheckpointData | undefined;
              if (data?.stashRef) survivingHashes.add(data.stashRef);
            }
          } catch {
            /* skip malformed line */
          }
        }
      } catch {
        /* skip unreadable file */
      }
    }
    scanOk = true;
  } catch {
    scanOk = false;
  }

  if (!scanOk) {
    // Cannot enumerate sibling sessions – never hard-prune blind.
    await gitCode("gc --prune=7.days");
    return;
  }

  const refPrefix = "refs/pi-checkpoints/";
  const protectedRefs: string[] = [];
  try {
    for (const hash of survivingHashes) {
      const ref = `${refPrefix}${hash}`;
      // update-ref fails for hashes whose objects are already gone – fine.
      if ((await gitCode(`update-ref ${ref} ${hash}`)) === 0) {
        protectedRefs.push(ref);
      }
    }
    await gitCode("gc --prune=now");
  } finally {
    for (const ref of protectedRefs) {
      await gitCode(`update-ref -d ${ref}`);
    }
  }
}

// ── Extension ───────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (patched) return;
    const sm = ctx.sessionManager as any;
    if (!sm) return;
    const result = ensureRemoveSubtree(sm);
    if (result.ok && result.patched) {
      patched = true;
    } else if (!result.ok) {
      ctx.ui.notify(
        `tree-delete: Failed to patch SessionManager — ${result.message ?? "unknown error"}`,
        "error",
      );
    }
  });

  /** Shortcut ctxs cannot refresh the chat pane – tell the user. */
  function staleChatHint(ctx: ExtensionCtx): void {
    ctx.ui.notify(
      "Chat view may show deleted messages until the next full refresh (/tree or restart)",
      "warning",
    );
  }

  // ── Delete: remove one subtree ────────────────────────────────────

  async function deleteSubtree(
    pi: ExtensionAPI,
    ctx: ExtensionCtx,
    sm: any,
    entryId: string,
    canNavigate: boolean,
  ): Promise<void> {
    const oldLeafId = sm.getLeafId();
    const oldLeafText = entryText(oldLeafId ? sm.getEntry(oldLeafId) : undefined);
    const removed = computeRemovedSubtree(sm, entryId);

    // Core or patched implementation – its return value is not trusted.
    sm.removeSubtree(entryId);
    repairLeafAfterRemoval(sm, removed.removedIds);
    const newLeafId = sm.getLeafId();
    const oldLeafRemoved = oldLeafId !== null && removed.removedIds.includes(oldLeafId);

    if (oldLeafRemoved) {
      if (newLeafId && canNavigate) {
        // Refreshes the chat pane and repositions the leaf (core applies the
        // user-message leaf rule itself).
        await ctx.navigateTree!(newLeafId, { summarize: false });
        ctx.ui.notify(
          `Deleted ${removed.removedIds.length} entries, moved to nearest surviving entry`,
          "info",
        );
      } else if (newLeafId) {
        // Shortcut path: no navigateTree – mirror its leaf rule manually.
        applyUserMessageLeafRule(sm, newLeafId);
        ctx.ui.notify(
          `Deleted ${removed.removedIds.length} entries, moved to nearest surviving entry`,
          "info",
        );
        staleChatHint(ctx);
      } else {
        ctx.ui.notify(
          `Deleted ${removed.removedIds.length} entries – the session tree is now empty`,
          "warning",
        );
        // Nothing to navigate to – the chat pane keeps showing the old messages
        // until the next full refresh in both ctxs.
        staleChatHint(ctx);
      }

      // The editor may still hold the deleted leaf's message text (the custom
      // component restores the pre-open editor content on close).  Replace it
      // with the new position's text only when it matches the deleted entry's
      // text; a user draft is never clobbered.
      const current =
        typeof ctx.ui.getEditorText === "function" ? ctx.ui.getEditorText() : "";
      if (oldLeafText !== undefined && current.trim() === oldLeafText.trim()) {
        ctx.ui.setEditorText(nearestUserMessageText(sm, newLeafId));
      }
    } else {
      ctx.ui.notify(`Deleted ${removed.removedIds.length} entries`, "info");
    }

    gcSnapshotRepo(pi, ctx.cwd, removed.removedCheckpoints, sm).catch((err) => {
      console.warn("tree-delete: snapshot GC failed:", err);
    });
  }

  // ── Prune: keep only the path Root → selected entry ───────────────

  async function pruneToPath(
    pi: ExtensionAPI,
    ctx: ExtensionCtx,
    sm: any,
    entryId: string,
    canNavigate: boolean,
  ): Promise<void> {
    const oldLeafId = sm.getLeafId();

    // Build the path from root to the selected entry.
    const path: string[] = [];
    let cursor: string | null = entryId;
    while (cursor) {
      path.unshift(cursor);
      const entry = sm.getEntry(cursor);
      cursor = entry?.parentId ?? null;
    }
    const pathSet = new Set(path);

    // Collect off-path subtrees: sibling subtrees at every level, plus the
    // selected entry's children (make it a leaf).
    const otherRoots = new Set<string>();
    for (const pathEntryId of path) {
      const entry = sm.getEntry(pathEntryId);
      if (!entry) continue;
      const siblings = entry.parentId ? sm.getChildren(entry.parentId) : [];
      for (const sibling of siblings) {
        if (!pathSet.has(sibling.id)) {
          otherRoots.add(sibling.id);
        }
      }
    }

    // Root-level entries not on the path.  Runs unconditionally (not just for
    // the path root) so orphaned roots with dangling parentIds are covered
    // too.  getTree() treats orphans as roots, so this may duplicate the
    // sibling sets above – the Set dedupes them.
    const currentTree = sm.getTree();
    for (const root of currentTree) {
      if (!pathSet.has(root.entry.id)) {
        otherRoots.add(root.entry.id);
      }
    }

    const selectedChildren = sm.getChildren(entryId);
    for (const child of selectedChildren) {
      otherRoots.add(child.id);
    }

    // Delete every off-path subtree.  The sets are disjoint, so any error here
    // is a real failure (e.g. disk error) – surface it instead of swallowing.
    let totalRemoved = 0;
    const allCheckpoints: CheckpointData[] = [];
    const errors: string[] = [];
    for (const rootId of otherRoots) {
      try {
        const removed = computeRemovedSubtree(sm, rootId);
        sm.removeSubtree(rootId);
        repairLeafAfterRemoval(sm, removed.removedIds);
        totalRemoved += removed.removedIds.length;
        allCheckpoints.push(...removed.removedCheckpoints);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    // Navigate to the selected entry.  For user-like targets the core rule is
    // "leaf = parent, message text goes to the editor" – delegate to
    // navigateTree(entryId) so the core computes it.  The manual fallback
    // mirrors exactly that rule (a single level up, not a walk).
    const targetEntry = sm.getEntry(entryId);
    const targetText = entryText(targetEntry);
    const targetLeaf =
      isUserLikeEntry(targetEntry) && targetEntry.parentId
        ? targetEntry.parentId
        : entryId;

    const currentLeaf = sm.getLeafId();
    if (currentLeaf !== targetLeaf) {
      if (canNavigate) {
        await ctx.navigateTree!(entryId, { summarize: false });
      } else {
        if (targetLeaf) {
          try {
            sm.branch(targetLeaf);
          } catch {
            /* keep current leaf */
          }
        } else {
          try {
            sm.resetLeaf();
          } catch {
            /* keep current leaf */
          }
        }
      }
    }

    // "Continue from here": put the target's message text into the editor.
    if (isUserLikeEntry(targetEntry) && targetText !== undefined) {
      ctx.ui.setEditorText(targetText);
    }

    const branchWord = otherRoots.size === 1 ? "branch" : "branches";
    const errorSuffix =
      errors.length > 0 ? `; ${errors.length} deletion(s) failed: ${errors[0]}` : "";
    ctx.ui.notify(
      `Pruned to selected path — removed ${totalRemoved} entries from ${otherRoots.size} other ${branchWord}${errorSuffix}`,
      "info",
    );

    // If the pre-prune position is gone, the visible path changed.
    if (!canNavigate && oldLeafId !== null && !sm.getEntry(oldLeafId)) {
      staleChatHint(ctx);
    }

    gcSnapshotRepo(pi, ctx.cwd, allCheckpoints, sm).catch((err) => {
      console.warn("tree-delete: snapshot GC failed:", err);
    });
  }

  // ── Shared entry point ────────────────────────────────────────────

  async function runDeleteSubtree(ctx: ExtensionCtx): Promise<void> {
    const sm = ctx.sessionManager as any;
    if (!patched) {
      const result = ensureRemoveSubtree(sm);
      if (!result.ok) {
        ctx.ui.notify(
          `tree-delete: patch failed${result.message ? ` (${result.message})` : ""}`,
          "error",
        );
        return;
      }
      if (result.patched) patched = true;
    }

    if (!ctx.hasUI) {
      ctx.ui.notify("This command requires TUI mode", "warning");
      return;
    }

    // Deleting while a response streams would leave in-flight messages
    // dangling from a repositioned leaf and make core navigateTree throw.
    // Mirror the core's own guard: refuse until idle.
    if (typeof ctx.isIdle === "function" && !ctx.isIdle()) {
      ctx.ui.notify(
        "Wait for the current response to finish before deleting",
        "warning",
      );
      return;
    }

    const tree = sm.getTree();
    if (tree.length === 0) {
      ctx.ui.notify("No entries in session", "info");
      return;
    }

    const realLeafId = sm.getLeafId();
    // Command ctxs have navigateTree (chat refresh + status).  Shortcut ctxs
    // (pi ≤ 0.84.2) do not – the manual fallback repositions leaf/editor.
    const canNavigate = typeof ctx.navigateTree === "function";

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
          // Route through the selector, not the tree list directly, so the
          // built-in label editor (Shift+L) keeps receiving keystrokes.
          handleInput: (data: string) => {
            selector.handleInput(data);
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

    try {
      if (action.action === "delete") {
        await deleteSubtree(pi, ctx, sm, action.entryId, canNavigate);
      } else {
        await pruneToPath(pi, ctx, sm, action.entryId, canNavigate);
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
