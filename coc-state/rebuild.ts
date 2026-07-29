import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GameState, Player } from "./types";
import { EMPTY_STATE } from "./types";
import { parseCount, addCounts, subCounts, countIsZero } from "./count";

export const WRITE_TOOLS = new Set([
  "pc_create", "pc_set", "pc_mod",
  "pc_item_add", "pc_item_rm", "pc_item_mod",
  "pc_status_add", "pc_status_rm",
  "npc_create", "npc_set",
  "clue_add", "scene_set",
  "combat_start", "combat_next", "combat_end",
]);

export function rebuildState(ctx: ExtensionContext): GameState {
  const state: GameState = structuredClone(EMPTY_STATE);
  const entries = ctx.sessionManager.getEntries();

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;

    if (entry.type === "custom" && entry.customType === "coc-snapshot") {
      if (entry.data && Object.keys(entry.data).length > 0) {
        return entry.data as GameState;
      }
      break;
    }

    if (entry.type === "message" && entry.message?.role === "toolResult") {
      const { toolName, details, isError } = entry.message;
      if (!WRITE_TOOLS.has(toolName) || isError) continue;
      if (!details?.result) continue;
      applyResult(state, toolName, details);
    }
  }

  return state;
}

function applyResult(state: GameState, toolName: string, details: any): void {
  switch (toolName) {
    case "pc_create": {
      const p = details.result.player as Player;
      if (!state.players[p.name]) {
        state.players[p.name] = p;
      }
      break;
    }
    case "pc_set":
    case "pc_mod": {
      const r = details.result;
      if (r.player) state.players[r.player.name] = r.player;
      break;
    }
    case "pc_item_add":
    case "pc_item_rm":
    case "pc_item_mod": {
      const r = details.result;
      if (r.player) state.players[r.player.name] = r.player;
      break;
    }
    case "pc_status_add":
    case "pc_status_rm": {
      const r = details.result;
      if (r.player) state.players[r.player.name] = r.player;
      break;
    }
    case "npc_create":
    case "npc_set": {
      const r = details.result;
      if (r.npc) state.npcs[r.npc.name] = r.npc;
      break;
    }
    case "clue_add": {
      const r = details.result;
      if (r.clues) state.clues = r.clues;
      break;
    }
    case "scene_set": {
      const r = details.result;
      if (r.scene) state.scene = r.scene;
      break;
    }
    case "combat_start":
    case "combat_next":
    case "combat_end": {
      const r = details.result;
      if (r.combat !== undefined) state.combat = r.combat;
      break;
    }
  }
}
