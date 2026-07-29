import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GameState, Player, Npc, Clue, InventoryItem } from "./types";
import { EMPTY_STATE } from "./types";
import { parseCount, addCounts, subCounts, countIsZero } from "./count";

export const WRITE_TOOLS = new Set([
  "pc_create", "pc_set", "pc_mod",
  "pc_item_add", "pc_item_rm", "pc_item_mod",
  "pc_status_add", "pc_status_rm",
  "npc_create", "npc_set",
  "clue_add", "scene_set", "coc_log",
  "combat_start", "combat_next", "combat_end",
]);

// ── Nested field helpers ──

function setNested(obj: any, field: string, value: any): void {
  const parts = field.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in cur)) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getNested(obj: any, field: string): any {
  const parts = field.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

// ── Inventory helpers ──

function findItem(inv: InventoryItem[], name: string): number {
  return inv.findIndex(i => i.name === name);
}

// ── Main rebuild ──

export function rebuildState(ctx: ExtensionContext): GameState {
  const entries = ctx.sessionManager.getEntries();

  let start = 0;
  let state: GameState = structuredClone(EMPTY_STATE);

  // Tail-scan for snapshot
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

  // Forward replay
  for (let i = start; i < entries.length; i++) {
    const entry = entries[i] as any;
    if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
    const { toolName, details, isError } = entry.message;
    if (!WRITE_TOOLS.has(toolName) || isError) continue;
    if (!details?.arguments) continue;
    applyDelta(state, toolName, details.arguments);
  }

  return state;
}

// ── Delta application ──

function applyDelta(state: GameState, toolName: string, args: any): void {
  switch (toolName) {
    case "pc_create": {
      const p = args as { name: string; hp?: number; san?: number; mp?: number; luck?: number; location?: string; status?: string[] };
      const player: Player = {
        name: p.name,
        hp: p.hp ?? 10, maxHp: p.hp ?? 10,
        san: p.san ?? 50, maxSan: p.san ?? 50,
        mp: p.mp ?? 10, maxMp: p.mp ?? 10,
        luck: p.luck ?? 50,
        location: p.location ?? state.scene.location,
        status: p.status ?? [],
        attributes: {}, skills: {}, inventory: [], notes: "",
      };
      state.players[p.name] = player;
      break;
    }

    case "pc_set": {
      const { name, field, value } = args as { name: string; field: string; value: any };
      const p = state.players[name];
      if (!p) return;

      if (field === "status") {
        p.status = Array.isArray(value) ? value : [];
        return;
      }

      setNested(p, field, value);
      // Clamp
      if (field === "hp") p.hp = Math.min(p.hp, p.maxHp);
      if (field === "san") p.san = Math.min(p.san, p.maxSan);
      if (field === "mp") p.mp = Math.min(p.mp, p.maxMp);
      break;
    }

    case "pc_mod": {
      const { name, field, delta } = args as { name: string; field: string; delta: number };
      const p = state.players[name];
      if (!p) return;

      // Auto-create skill
      if (field.startsWith("skills.") && getNested(p, field) === undefined) {
        setNested(p, field, 0);
      }

      const oldVal = getNested(p, field);
      if (typeof oldVal !== "number") return;
      setNested(p, field, oldVal + delta);

      // Clamp to [0, max]
      if (field === "hp") p.hp = Math.min(Math.max(0, p.hp), p.maxHp);
      if (field === "san") p.san = Math.min(Math.max(0, p.san), p.maxSan);
      if (field === "mp") p.mp = Math.min(Math.max(0, p.mp), p.maxMp);
      break;
    }

    case "pc_status_add": {
      const { name, status } = args as { name: string; status: string };
      const p = state.players[name];
      if (!p || p.status.includes(status)) return;
      p.status.push(status);
      break;
    }

    case "pc_status_rm": {
      const { name, status } = args as { name: string; status: string };
      const p = state.players[name];
      if (!p) return;
      const idx = p.status.indexOf(status);
      if (idx !== -1) p.status.splice(idx, 1);
      break;
    }

    case "pc_item_add": {
      const { name, item, count } = args as { name: string; item: string; count?: number | string };
      const p = state.players[name];
      if (!p) return;
      const addCount = parseCount(count);
      const idx = findItem(p.inventory, item);
      if (idx !== -1) {
        p.inventory[idx].count = addCounts(p.inventory[idx].count, addCount);
      } else {
        p.inventory.push({ name: item, count: addCount });
      }
      break;
    }

    case "pc_item_rm": {
      const { name, item, count } = args as { name: string; item: string; count?: number | string };
      const p = state.players[name];
      if (!p) return;
      const idx = findItem(p.inventory, item);
      if (idx === -1) return;
      if (count === undefined) {
        p.inventory.splice(idx, 1);
      } else {
        const rmCount = parseCount(count);
        p.inventory[idx].count = subCounts(p.inventory[idx].count, rmCount);
        if (countIsZero(p.inventory[idx].count)) {
          p.inventory.splice(idx, 1);
        }
      }
      break;
    }

    case "pc_item_mod": {
      const { name, item, newItem, count } = args as { name: string; item: string; newItem: string; count?: number | string };
      const p = state.players[name];
      if (!p) return;
      const idx = findItem(p.inventory, item);
      if (idx === -1) return;

      const modCount = count !== undefined ? parseCount(count) : null;
      const existing = p.inventory[idx];

      if (modCount === null) {
        existing.name = newItem;
      } else {
        const remaining = subCounts(existing.count, modCount);
        if (countIsZero(remaining)) {
          existing.name = newItem;
          existing.count = modCount;
        } else {
          existing.count = remaining;
          const newIdx = findItem(p.inventory, newItem);
          if (newIdx !== -1) {
            p.inventory[newIdx].count = addCounts(p.inventory[newIdx].count, modCount);
          } else {
            p.inventory.push({ name: newItem, count: modCount });
          }
        }
      }
      break;
    }

    case "npc_create": {
      const n = args as { name: string; role?: string; location?: string; attitude?: string; status?: string[]; notes?: string };
      const npc: Npc = {
        name: n.name,
        role: n.role ?? "",
        location: n.location ?? "",
        attitude: n.attitude ?? "中⽴",
        status: n.status ?? [],
        notes: n.notes ?? "",
      };
      state.npcs[n.name] = npc;
      break;
    }

    case "npc_set": {
      const { name, field, value } = args as { name: string; field: string; value: any };
      const npc = state.npcs[name];
      if (!npc) return;
      if (field === "status") {
        npc.status = Array.isArray(value) ? value : [];
      } else {
        (npc as any)[field] = value;
      }
      break;
    }

    case "clue_add": {
      const c = args as { name: string; desc: string; location: string; npc: string | null };
      const clue: Clue = {
        name: c.name,
        desc: c.desc,
        location: c.location,
        npc: c.npc ?? null,
      };
      state.clues.push(clue);
      break;
    }

    case "scene_set": {
      const s = args as { location?: string; time?: string };
      if (s.location !== undefined) state.scene.location = s.location;
      if (s.time !== undefined) state.scene.time = s.time;
      break;
    }

    case "coc_log": {
      const { message } = args as { message: string };
      state.log.push({ timestamp: new Date().toISOString(), message });
      break;
    }
      const c = args as { participants: string };
      const participants = c.participants.split(",").map(s => s.trim()).filter(Boolean);
      if (participants.length >= 2) {
        state.combat = { participants, currentIndex: 0, round: 1 };
      }
      break;
    }

    case "combat_next": {
      if (!state.combat) return;
      state.combat.currentIndex++;
      if (state.combat.currentIndex >= state.combat.participants.length) {
        state.combat.currentIndex = 0;
        state.combat.round++;
      }
      break;
    }

    case "combat_end": {
      state.combat = null;
      break;
    }
  }
}
