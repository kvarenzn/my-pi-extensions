import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { GameState, Player, Npc, InventoryItem, Count } from "./types";
import { NUMERIC_FIELDS } from "./types";
import { rebuildState } from "./rebuild";
import { parseCount, addCounts, subCounts, countIsZero, formatCount } from "./count";

// ── Helpers ──

export function formatInventory(items: InventoryItem[]): string {
  if (items.length === 0) return "(空)";
  return items.map(i => {
    const cnt = formatCount(i.count);
    if (cnt === "1") return i.name;
    return `${i.name} x${cnt}`;
  }).join(", ");
}

function formatPlayer(p: Player): string {
  const lines: string[] = [];
  lines.push(`${p.name} | HP ${p.hp}/${p.maxHp} | SAN ${p.san}/${p.maxSan} | MP ${p.mp}/${p.maxMp} | LUCK ${p.luck} | 位置: ${p.location || "未知"}`);
  if (p.status.length > 0) lines.push(`  状态: ${p.status.join(", ")}`);

  const attrs = Object.entries(p.attributes);
  if (attrs.length > 0) {
    lines.push(`  属性: ${attrs.map(([k, v]) => `${k}(${v})`).join(", ")}`);
  }

  const skills = Object.entries(p.skills);
  if (skills.length > 0) {
    lines.push(`  技能: ${skills.map(([k, v]) => `${k}(${v})`).join(", ")}`);
  }

  lines.push(`  物品: ${formatInventory(p.inventory)}`);
  if (p.notes) lines.push(`  备注: ${p.notes}`);
  return lines.join("\n");
}

export function getPlayerOrThrow(state: GameState, name: string): Player {
  const p = state.players[name];
  if (!p) {
    const names = Object.keys(state.players).join(", ") || "(无)";
    throw new Error(`未找到"${name}"。当前角色: ${names}\n如需创建调查员请使用 pc_create`);
  }
  return p;
}

function clonePlayer(p: Player): Player {
  return structuredClone(p);
}

function setNestedField(obj: any, field: string, value: any): void {
  const parts = field.split(".");
  let current = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current)) current[parts[i]] = {};
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;
}

function getNestedField(obj: any, field: string): any {
  const parts = field.split(".");
  let current = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[part];
  }
  return current;
}

function findItemIndex(inv: InventoryItem[], name: string): number {
  return inv.findIndex(i => i.name === name);
}

// ── Query Tools ──

export async function executePcGet(
  params: { name?: string; location?: string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  const players = Object.values(state.players);

  let filtered = players;
  if (params.name) {
    const p = state.players[params.name];
    if (!p) {
      const names = Object.keys(state.players).join(", ") || "(无)";
      throw new Error(`未找到"${params.name}"。当前角色: ${names}`);
    }
    filtered = [p];
  }
  if (params.location) {
    filtered = filtered.filter(p => p.location === params.location);
  }

  const text = filtered.length === 0
    ? "暂无调查员信息。"
    : filtered.map(formatPlayer).join("\n\n");

  return {
    content: [{ type: "text" as const, text }],
    details: { arguments: params, result: { players: filtered } },
  };
}

export async function executeNpcGet(
  params: { name?: string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);

  if (params.name) {
    const npc = state.npcs[params.name];
    if (!npc) {
      const names = Object.keys(state.npcs).join(", ") || "(无)";
      throw new Error(`未找到NPC"${params.name}"。已知NPC: ${names}`);
    }
    const text = [
      `${npc.name} | ${npc.role || "未知身份"} | 位置: ${npc.location || "未知"}`,
      `  态度: ${npc.attitude || "中立"}`,
      npc.notes ? `  备注: ${npc.notes}` : "",
    ].filter(Boolean).join("\n");
    return {
      content: [{ type: "text" as const, text }],
      details: { arguments: params, result: { npc } },
    };
  }

  const npcs = Object.values(state.npcs);
  if (npcs.length === 0) {
    return {
      content: [{ type: "text" as const, text: "暂无NPC。" }],
      details: { arguments: params, result: { npcs: [] } },
    };
  }
  const text = npcs.map(n =>
    `${n.name} (${n.role || "?"}) - ${n.location || "?"} [${n.attitude || "中立"}]`
  ).join("\n");
  return {
    content: [{ type: "text" as const, text }],
    details: { arguments: params, result: { npcs } },
  };
}

export async function executeClueList(
  params: { location?: string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  let clues = state.clues;
  if (params.location) {
    clues = clues.filter(c => c.location === params.location);
  }

  if (clues.length === 0) {
    const loc = params.location ? ` (${params.location})` : "";
    return {
      content: [{ type: "text" as const, text: `线索${loc}: 无` }],
      details: { arguments: params, result: { clues: [] } },
    };
  }

  const text = clues.map((c, i) =>
    `${i + 1}. ${c.name}${c.location ? ` [${c.location}]` : ""}${c.npc ? ` (来自: ${c.npc})` : ""}: ${c.desc}`
  ).join("\n");
  return {
    content: [{ type: "text" as const, text }],
    details: { arguments: params, result: { clues } },
  };
}

export async function executeSceneGet(
  _params: {},
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  const s = state.scene;
  const text = `当前场景: ${s.location || "未知"} | 时间: ${s.time || "未知"}`;
  return {
    content: [{ type: "text" as const, text }],
    details: { arguments: {}, result: { scene: s } },
  };
}

export async function executeCombatStatus(
  _params: {},
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  const c = state.combat;
  if (!c) {
    return {
      content: [{ type: "text" as const, text: "当前无战斗进行中。" }],
      details: { arguments: {}, result: { combat: null } },
    };
  }
  const order = c.participants.join(" → ");
  const current = c.participants[c.currentIndex];
  const text = `第${c.round}轮 | 当前行动: ${current} | 顺序: ${order}`;
  return {
    content: [{ type: "text" as const, text }],
    details: { arguments: {}, result: { combat: c } },
  };
}

// ── Player Mutation Tools ──

export async function executePcCreate(
  params: { name: string; hp?: number; san?: number; mp?: number; luck?: number; location?: string; status?: string[] },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  if (state.players[params.name]) {
    throw new Error(`"${params.name}"已存在，如需修改请使用 pc_set`);
  }

  const player: Player = {
    name: params.name,
    hp: params.hp ?? 10,
    maxHp: params.hp ?? 10,
    san: params.san ?? 50,
    maxSan: params.san ?? 50,
    mp: params.mp ?? 10,
    maxMp: params.mp ?? 10,
    luck: params.luck ?? 50,
    location: params.location ?? state.scene.location,
    status: params.status ?? [],
    attributes: {},
    skills: {},
    inventory: [],
    notes: "",
  };

  return {
    content: [{ type: "text" as const, text: `已创建调查员 ${params.name}（HP ${player.hp}/${player.maxHp} SAN ${player.san}/${player.maxSan}）` }],
    details: { arguments: params, result: { player } },
  };
}

export async function executePcSet(
  params: { name: string; field: string; value: number | string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  const oldPlayer = getPlayerOrThrow(state, params.name);
  const player = clonePlayer(oldPlayer);

  const { field, value } = params;

  if (NUMERIC_FIELDS.has(field)) {
    if (typeof value !== "number") throw new Error(`"${field}"是数值域，收到字符串"${value}"`);
    if (!Number.isInteger(value)) throw new Error(`"${field}"需要整数，收到 ${value}`);
  } else if (field === "status") {
    if (!Array.isArray(value)) throw new Error(`"status"是数组域，收到 ${typeof value}`);
    player.status = value as string[];
    const text = `${params.name} 状态 → ${player.status.join(", ") || "(无)"}`;
    return {
      content: [{ type: "text" as const, text }],
      details: { arguments: params, result: { field, value: player.status } },
    };
  } else if (field === "inventory") {
    throw new Error(`"inventory"请使用 pc_item_add / pc_item_rm 操作`);
  }

  if (field.startsWith("attributes.") || field.startsWith("skills.")) {
    if (typeof value !== "number") throw new Error(`"${field}"是数值域，收到字符串"${value}"`);
    if (!Number.isInteger(value)) throw new Error(`"${field}"需要整数，收到 ${value}`);
    setNestedField(player, field, value);
  } else if (NUMERIC_FIELDS.has(field)) {
    (player as any)[field] = value as number;
    if (field === "hp") player.hp = Math.min(player.hp, player.maxHp);
    if (field === "san") player.san = Math.min(player.san, player.maxSan);
    if (field === "mp") player.mp = Math.min(player.mp, player.maxMp);
  } else {
    if (typeof value !== "string") throw new Error(`"${field}"是文本域，收到 ${typeof value}`);
    (player as any)[field] = value;
  }

  const oldValue = getNestedField(oldPlayer, field);
  const newValue = getNestedField(player, field);

  return {
    content: [{ type: "text" as const, text: `${params.name} ${field}: ${oldValue} → ${newValue}` }],
    details: { arguments: params, result: { field, value } },
  };
}

export async function executePcMod(
  params: { name: string; field: string; delta: number },
  ctx: ExtensionContext
) {
  if (!Number.isInteger(params.delta)) throw new Error(`delta 必须为整数，收到 ${params.delta}`);

  const state = rebuildState(ctx);
  const oldPlayer = getPlayerOrThrow(state, params.name);
  const player = clonePlayer(oldPlayer);

  const { field, delta } = params;

  if (!NUMERIC_FIELDS.has(field) && !field.startsWith("attributes.") && !field.startsWith("skills.")) {
    const current = getNestedField(oldPlayer, field);
    throw new Error(`"${field}"不是数值域（当前值: ${JSON.stringify(current)}），请使用 pc_set`);
  }

  if (field.startsWith("skills.")) {
    const current = getNestedField(player, field);
    if (current === undefined) {
      setNestedField(player, field, 0);
    }
  }

  const oldValue = getNestedField(player, field);
  if (typeof oldValue !== "number") {
    throw new Error(`"${field}"当前值不是数字: ${oldValue}`);
  }

  const newValue = oldValue + delta;
  setNestedField(player, field, newValue);

  if (field === "hp") player.hp = Math.min(player.hp, player.maxHp);
  if (field === "san") player.san = Math.min(player.san, player.maxSan);
  if (field === "mp") player.mp = Math.min(player.mp, player.maxMp);

  return {
    content: [{ type: "text" as const, text: `${params.name} ${field}: ${oldValue} → ${newValue} (${delta >= 0 ? "+" : ""}${delta})` }],
    details: { arguments: params, result: { field, delta } },
  };
}

export async function executePcStatusAdd(
  params: { name: string; status: string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  const oldPlayer = getPlayerOrThrow(state, params.name);
  const player = clonePlayer(oldPlayer);

  if (!player.status.includes(params.status)) {
    player.status = [...player.status, params.status];
  }

  return {
    content: [{ type: "text" as const, text: `${params.name} 添加状态: ${params.status}（当前: ${player.status.join(", ")}）` }],
    details: { arguments: params, result: { status: params.status } },
  };
}

export async function executePcStatusRm(
  params: { name: string; status: string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  const oldPlayer = getPlayerOrThrow(state, params.name);
  const player = clonePlayer(oldPlayer);

  const idx = player.status.indexOf(params.status);
  if (idx === -1) {
    throw new Error(`"${params.status}"不在 ${params.name} 的状态中。当前状态: ${player.status.join(", ") || "(无)"}`);
  }
  player.status.splice(idx, 1);

  return {
    content: [{ type: "text" as const, text: `${params.name} 移除状态: ${params.status}（当前: ${player.status.join(", ") || "(无)"}）` }],
    details: { arguments: params, result: { status: params.status } },
  };
}

// ── Item Tools ──

export async function executePcItemAdd(
  params: { name: string; item: string; count?: number | string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  const oldPlayer = getPlayerOrThrow(state, params.name);
  const player = clonePlayer(oldPlayer);

  const addCount = parseCount(params.count);
  const idx = findItemIndex(player.inventory, params.item);

  if (idx !== -1) {
    player.inventory[idx].count = addCounts(player.inventory[idx].count, addCount);
  } else {
    player.inventory.push({ name: params.item, count: addCount });
  }

  const display = formatInventory(player.inventory);
  return {
    content: [{ type: "text" as const, text: `${params.name} 获得: ${params.item}${params.count !== undefined ? " x" + formatCount(addCount) : ""}。物品: ${display}` }],
    details: { arguments: params, result: { item: params.item, count: params.count } },
  };
}

export async function executePcItemRm(
  params: { name: string; item: string; count?: number | string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  const oldPlayer = getPlayerOrThrow(state, params.name);
  const player = clonePlayer(oldPlayer);

  const idx = findItemIndex(player.inventory, params.item);
  if (idx === -1) {
    const names = player.inventory.map(i => i.name).join(", ") || "(空)";
    throw new Error(`"${params.item}"不在 ${params.name} 的物品中。当前物品: ${names}`);
  }

  if (params.count === undefined) {
    player.inventory.splice(idx, 1);
  } else {
    const rmCount = parseCount(params.count);
    player.inventory[idx].count = subCounts(player.inventory[idx].count, rmCount);
    if (countIsZero(player.inventory[idx].count)) {
      player.inventory.splice(idx, 1);
    }
  }

  const display = formatInventory(player.inventory);
  return {
    content: [{ type: "text" as const, text: `${params.name} 失去: ${params.item}${params.count !== undefined ? " x" + formatCount(parseCount(params.count)) : ""}。物品: ${display}` }],
    details: { arguments: params, result: { item: params.item, count: params.count } },
  };
}

export async function executePcItemMod(
  params: { name: string; item: string; newItem: string; count?: number | string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  const oldPlayer = getPlayerOrThrow(state, params.name);
  const player = clonePlayer(oldPlayer);

  const idx = findItemIndex(player.inventory, params.item);
  if (idx === -1) {
    const names = player.inventory.map(i => i.name).join(", ") || "(空)";
    throw new Error(`"${params.item}"不在 ${params.name} 的物品中。当前物品: ${names}`);
  }

  const existingItem = player.inventory[idx];
  const modCount = params.count !== undefined ? parseCount(params.count) : null;

  if (modCount === null) {
    existingItem.name = params.newItem;
  } else {
    const remaining = subCounts(existingItem.count, modCount);
    if (countIsZero(remaining)) {
      existingItem.name = params.newItem;
      existingItem.count = modCount;
    } else {
      existingItem.count = remaining;
      const newIdx = findItemIndex(player.inventory, params.newItem);
      if (newIdx !== -1) {
        player.inventory[newIdx].count = addCounts(player.inventory[newIdx].count, modCount);
      } else {
        player.inventory.push({ name: params.newItem, count: modCount });
      }
    }
  }

  const display = formatInventory(player.inventory);
  return {
    content: [{ type: "text" as const, text: `${params.name} 物品变更: ${params.item} → ${params.newItem}${modCount ? " x" + formatCount(modCount) : ""}。物品: ${display}` }],
    details: { arguments: params, result: { item: params.item, newItem: params.newItem, count: params.count } },
  };
}

// ── NPC, Clue, Scene Write Tools ──

export async function executeNpcCreate(
  params: { name: string; role?: string; location?: string; attitude?: string; notes?: string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  if (state.npcs[params.name]) {
    throw new Error(`NPC "${params.name}"已存在，如需修改请使用 npc_set`);
  }

  const npc: Npc = {
    name: params.name,
    role: params.role ?? "",
    location: params.location ?? "",
    attitude: params.attitude ?? "中立",
    notes: params.notes ?? "",
  };

  return {
    content: [{ type: "text" as const, text: `已创建NPC: ${npc.name}（${npc.role || "未知身份"}）` }],
    details: { arguments: params, result: { npc } },
  };
}

export async function executeNpcSet(
  params: { name: string; field: string; value: string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  const oldNpc = state.npcs[params.name];
  if (!oldNpc) {
    const names = Object.keys(state.npcs).join(", ") || "(无)";
    throw new Error(`未找到NPC"${params.name}"。已知NPC: ${names}\n如需创建NPC请使用 npc_create`);
  }

  const npc = structuredClone(oldNpc);
  const validFields = ["role", "location", "attitude", "notes"];
  if (!validFields.includes(params.field)) {
    throw new Error(`"${params.field}"不是NPC的有效域。有效域: ${validFields.join(", ")}`);
  }
  (npc as any)[params.field] = params.value;

  return {
    content: [{ type: "text" as const, text: `${params.name} ${params.field}: ${(oldNpc as any)[params.field]} → ${params.value}` }],
    details: { arguments: params, result: { field: params.field, value: params.value } },
  };
}

export async function executeClueAdd(
  params: { name: string; desc: string; location?: string; npc?: string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  const clues = [...state.clues, {
    name: params.name,
    desc: params.desc,
    location: params.location ?? state.scene.location,
    npc: params.npc ?? null,
  }];

  return {
    content: [{ type: "text" as const, text: `新线索: ${params.name}${params.location ? " [" + params.location + "]" : ""}` }],
    details: { arguments: params, result: { name: params.name, desc: params.desc, location: params.location ?? state.scene.location, npc: params.npc ?? null } },
  };
}

export async function executeSceneSet(
  params: { location?: string; time?: string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  const scene = { ...state.scene };
  if (params.location !== undefined) scene.location = params.location;
  if (params.time !== undefined) scene.time = params.time;

  return {
    content: [{ type: "text" as const, text: `场景更新 → 位置: ${scene.location || "未知"} | 时间: ${scene.time || "未知"}` }],
    details: { arguments: params, result: { location: params.location, time: params.time } },
  };
}

// ── Combat Tools ──

export async function executeCombatStart(
  params: { participants: string },
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  if (state.combat) {
    throw new Error("已有战斗进行中。请先调用 combat_end 结束当前战斗。");
  }

  const participants = params.participants.split(",").map(s => s.trim()).filter(Boolean);
  if (participants.length < 2) {
    throw new Error("战斗参与者至少需要2人（逗号分隔）");
  }

  const combat = {
    participants,
    currentIndex: 0,
    round: 1,
  };

  return {
    content: [{ type: "text" as const, text: `战斗开始！第1轮 | 当前行动: ${participants[0]} | 顺序: ${participants.join(" → ")}` }],
    details: { arguments: params, result: { combat } },
  };
}

export async function executeCombatNext(
  _params: {},
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  if (!state.combat) {
    throw new Error("当前无战斗进行中。请使用 combat_start 开始战斗。");
  }

  const combat = structuredClone(state.combat);
  combat.currentIndex++;
  if (combat.currentIndex >= combat.participants.length) {
    combat.currentIndex = 0;
    combat.round++;
  }

  const current = combat.participants[combat.currentIndex];
  return {
    content: [{ type: "text" as const, text: `第${combat.round}轮 | 当前行动: ${current}` }],
    details: { arguments: {}, result: { combat } },
  };
}

export async function executeCombatEnd(
  _params: {},
  ctx: ExtensionContext
) {
  const state = rebuildState(ctx);
  if (!state.combat) {
    throw new Error("当前无战斗进行中。");
  }

  return {
    content: [{ type: "text" as const, text: "战斗结束。" }],
    details: { arguments: {}, result: { combat: null } },
  };
}
