import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { rebuildState } from "./rebuild";
import {
  executePcGet, executeNpcGet, executeClueList, executeSceneGet, executeCombatStatus,
  executePcCreate, executePcSet, executePcMod, executePcStatusAdd, executePcStatusRm,
  executePcItemAdd, executePcItemRm, executePcItemMod,
  executeNpcCreate, executeNpcSet, executeClueAdd, executeSceneSet,
  executeCombatStart, executeCombatNext, executeCombatEnd,
} from "./tools";

export default function (pi: ExtensionAPI) {
  // ═══ Query Tools ═══

  pi.registerTool({
    name: "pc_get",
    label: "查询调查员",
    description: "查询调查员状态。不传参数返回全部调查员概要；传 name 查特定角色；传 location 按地点过滤。",
    promptSnippet: "Query investigator status",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "调查员姓名（可选）" })),
      location: Type.Optional(Type.String({ description: "按地点过滤（可选）" })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executePcGet(params, ctx),
  });

  pi.registerTool({
    name: "npc_get",
    label: "查询NPC",
    description: "查询NPC信息。不传参数返回全部NPC列表；传 name 查特定NPC。",
    promptSnippet: "Query NPC information",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "NPC姓名（可选）" })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executeNpcGet(params, ctx),
  });

  pi.registerTool({
    name: "clue_list",
    label: "列出线索",
    description: "列出已发现的线索。可按地点过滤。",
    promptSnippet: "List discovered clues",
    parameters: Type.Object({
      location: Type.Optional(Type.String({ description: "按地点过滤（可选）" })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executeClueList(params, ctx),
  });

  pi.registerTool({
    name: "scene_get",
    label: "查看场景",
    description: "查看当前场景位置和时间。",
    promptSnippet: "View current scene",
    parameters: Type.Object({}),
    execute: (_id, params, _signal, _onUpdate, ctx) => executeSceneGet(params, ctx),
  });

  pi.registerTool({
    name: "combat_status",
    label: "查看战斗状态",
    description: "查看当前战斗状态（参与者、行动顺序、当前行动者）。",
    promptSnippet: "View combat status",
    parameters: Type.Object({}),
    execute: (_id, params, _signal, _onUpdate, ctx) => executeCombatStatus(params, ctx),
  });

  // ═══ Player Mutation Tools ═══

  pi.registerTool({
    name: "pc_create",
    label: "创建调查员",
    description: "创建新的调查员角色。hp/san/mp/luck 默认值为10/50/10/50。",
    promptSnippet: "Create investigator",
    parameters: Type.Object({
      name: Type.String({ description: "调查员姓名" }),
      hp: Type.Optional(Type.Integer({ description: "当前/最大HP（默认10）" })),
      san: Type.Optional(Type.Integer({ description: "当前/最大SAN（默认50）" })),
      mp: Type.Optional(Type.Integer({ description: "当前/最大MP（默认10）" })),
      luck: Type.Optional(Type.Integer({ description: "幸运值（默认50）" })),
      location: Type.Optional(Type.String({ description: "所在地点（默认当前场景）" })),
      status: Type.Optional(Type.Array(Type.String(), { description: "初始状态列表" })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executePcCreate(params, ctx),
  });

  pi.registerTool({
    name: "pc_set",
    label: "设置调查员属性",
    description: "设置调查员的属性/技能/状态。数值域: hp, maxHp, san, maxSan, mp, maxMp, luck, attributes.X, skills.X。文本域: location, notes。数组域: status。inventory请用 pc_item_add/rm。",
    promptSnippet: "Set investigator attribute",
    parameters: Type.Object({
      name: Type.String({ description: "调查员姓名" }),
      field: Type.String({ description: "域名称（如 hp, san, attributes.STR, skills.图书馆）" }),
      value: Type.Union([Type.Number(), Type.String(), Type.Array(Type.String())]),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executePcSet(params, ctx),
  });

  pi.registerTool({
    name: "pc_mod",
    label: "增减数值",
    description: "增减调查员的数值域（hp, maxHp, san, maxSan, mp, maxMp, luck, attributes.*, skills.*）。delta 正数为增加，负数为减少。",
    promptSnippet: "Modify numeric value",
    parameters: Type.Object({
      name: Type.String({ description: "调查员姓名" }),
      field: Type.String({ description: "数值域名称" }),
      delta: Type.Integer({ description: "变化量（正数=增加，负数=减少）" }),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executePcMod(params, ctx),
  });

  pi.registerTool({
    name: "pc_status_add",
    label: "添加状态",
    description: "为调查员添加状态效果（如：中毒、晕眩、燃运）。",
    promptSnippet: "Add status effect",
    parameters: Type.Object({
      name: Type.String({ description: "调查员姓名" }),
      status: Type.String({ description: "状态名称" }),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executePcStatusAdd(params, ctx),
  });

  pi.registerTool({
    name: "pc_status_rm",
    label: "移除状态",
    description: "移除调查员的状态效果。",
    promptSnippet: "Remove status effect",
    parameters: Type.Object({
      name: Type.String({ description: "调查员姓名" }),
      status: Type.String({ description: "状态名称" }),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executePcStatusRm(params, ctx),
  });

  // ═══ Item Tools ═══

  pi.registerTool({
    name: "pc_item_add",
    label: "添加物品",
    description: "为调查员添加物品。count 支持整数(4)、分数(\"1/4\")、模糊量词(\"若干\")。同名物品自动合并。",
    promptSnippet: "Add item to inventory",
    parameters: Type.Object({
      name: Type.String({ description: "调查员姓名" }),
      item: Type.String({ description: "物品名称" }),
      count: Type.Optional(Type.Union([Type.Integer(), Type.String()], { description: "数量（省略默认为1）" })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executePcItemAdd(params, ctx),
  });

  pi.registerTool({
    name: "pc_item_rm",
    label: "移除物品",
    description: "移除调查员的物品。count 省略则全部移除；指定则移除部分。",
    promptSnippet: "Remove item from inventory",
    parameters: Type.Object({
      name: Type.String({ description: "调查员姓名" }),
      item: Type.String({ description: "物品名称" }),
      count: Type.Optional(Type.Union([Type.Integer(), Type.String()], { description: "数量（省略=全部移除）" })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executePcItemRm(params, ctx),
  });

  pi.registerTool({
    name: "pc_item_mod",
    label: "修改物品",
    description: "修改物品名称/状态/数量。常用于物品状态变更（如：旧印（未激活）→ 旧印（已激活））。count 省略则修改全部；指定则只修改部分数量并保留剩余旧物品。",
    promptSnippet: "Modify item",
    parameters: Type.Object({
      name: Type.String({ description: "调查员姓名" }),
      item: Type.String({ description: "原物品名称" }),
      newItem: Type.String({ description: "新物品名称" }),
      count: Type.Optional(Type.Union([Type.Integer(), Type.String()], { description: "修改数量（省略=全部修改）" })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executePcItemMod(params, ctx),
  });

  // ═══ NPC Tools ═══

  pi.registerTool({
    name: "npc_create",
    label: "创建NPC",
    description: "创建新的NPC角色。",
    promptSnippet: "Create NPC",
    parameters: Type.Object({
      name: Type.String({ description: "NPC姓名" }),
      role: Type.Optional(Type.String({ description: "身份/职业" })),
      location: Type.Optional(Type.String({ description: "所在地点" })),
      attitude: Type.Optional(Type.String({ description: "态度（默认: 中立）" })),
      notes: Type.Optional(Type.String({ description: "备注" })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executeNpcCreate(params, ctx),
  });

  pi.registerTool({
    name: "npc_set",
    label: "修改NPC",
    description: "更新NPC的属性。有效域: role, location, attitude, notes。",
    promptSnippet: "Modify NPC",
    parameters: Type.Object({
      name: Type.String({ description: "NPC姓名" }),
      field: Type.String({ description: "域名称（role/location/attitude/notes）" }),
      value: Type.String({ description: "新值" }),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executeNpcSet(params, ctx),
  });

  // ═══ Clue & Scene Tools ═══

  pi.registerTool({
    name: "clue_add",
    label: "添加线索",
    description: "记录新发现的线索。location 默认为当前场景，npc 为提供线索的NPC。",
    promptSnippet: "Add clue",
    parameters: Type.Object({
      name: Type.String({ description: "线索名称" }),
      desc: Type.String({ description: "线索描述" }),
      location: Type.Optional(Type.String({ description: "发现地点（默认当前场景）" })),
      npc: Type.Optional(Type.String({ description: "提供线索的NPC" })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executeClueAdd(params, ctx),
  });

  pi.registerTool({
    name: "scene_set",
    label: "设置场景",
    description: "切换或更新当前场景的位置和时间。",
    promptSnippet: "Set scene",
    parameters: Type.Object({
      location: Type.Optional(Type.String({ description: "新地点" })),
      time: Type.Optional(Type.String({ description: "新时间" })),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executeSceneSet(params, ctx),
  });

  // ═══ Combat Tools ═══

  pi.registerTool({
    name: "combat_start",
    label: "开始战斗",
    description: "开始战斗回合。participants 为逗号分隔的参与者行动顺序（如 \"安娜,鮑勃,深潜者\"）。",
    promptSnippet: "Start combat",
    parameters: Type.Object({
      participants: Type.String({ description: "参与者列表，逗号分隔（如 \"安娜,鮑勃,深潜者\"）" }),
    }),
    execute: (_id, params, _signal, _onUpdate, ctx) => executeCombatStart(params, ctx),
  });

  pi.registerTool({
    name: "combat_next",
    label: "下一行动",
    description: "当前行动者回合结束，轮到下一个参与者行动。回合轮完自动进入下一轮。",
    promptSnippet: "Next combat turn",
    parameters: Type.Object({}),
    execute: (_id, params, _signal, _onUpdate, ctx) => executeCombatNext(params, ctx),
  });

  pi.registerTool({
    name: "combat_end",
    label: "结束战斗",
    description: "结束当前战斗。",
    promptSnippet: "End combat",
    parameters: Type.Object({}),
    execute: (_id, params, _signal, _onUpdate, ctx) => executeCombatEnd(params, ctx),
  });

  // ═══ Session Event Handlers (Snapshots) ═══

  pi.on("session_start", () => {
    pi.appendEntry("coc-snapshot", {});
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const state = rebuildState(ctx);
    pi.appendEntry("coc-snapshot", state);
    return undefined;
  });
}
