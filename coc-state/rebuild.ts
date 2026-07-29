import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GameState, Player } from "./types";
import { EMPTY_STATE } from "./types";

export const WRITE_TOOLS = new Set([
  "pc_create", "pc_set", "pc_mod",
  "pc_item_add", "pc_item_rm", "pc_item_mod",
  "pc_status_add", "pc_status_rm",
  "npc_create", "npc_set",
  "clue_add", "scene_set",
  "combat_start", "combat_next", "combat_end",
]);

export function rebuildState(ctx: ExtensionContext): GameState {
  const entries = ctx.sessionManager.getEntries();

  let start = 0;
  let state: GameState = structuredClone(EMPTY_STATE);

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] as any;
    if (entry.type === "custom" && entry.customType === "coc-snapshot") {
      const data = entry.data as GameState | undefined;
      if (data && Object.keys(data).length > 0) {
        state = structuredClone(data);
      }
      start = i + 1;
      break;
    }
  }

  for (let i = start; i < entries.length; i++) {
    const entry = entries[i] as any;
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
      state.players[p.name] = p;
      break;
    }
    case "pc_set":
    case "pc_mod":
    case "pc_item_add":
    case "pc_item_rm":
    case "pc_item_mod":
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
