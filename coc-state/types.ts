export interface Count {
  approx: string;
  denominator: number;
  numerator: number;
}

export interface InventoryItem {
  name: string;
  count: Count;
  notes?: string;
}

export interface PlayerSkills {
  [skillName: string]: number;
}

export interface PlayerAttributes {
  [attrName: string]: number;
}

export interface Player {
  name: string;
  hp: number;
  maxHp: number;
  san: number;
  maxSan: number;
  mp: number;
  maxMp: number;
  luck: number;
  location: string;
  status: string[];
  attributes: PlayerAttributes;
  skills: PlayerSkills;
  inventory: InventoryItem[];
  notes: string;
}

export interface Npc {
  name: string;
  role: string;
  location: string;
  attitude: string;
  status: string[];
  notes: string;
}

export interface Clue {
  name: string;
  desc: string;
  location: string;
  npc: string | null;
}

export interface Scene {
  location: string;
  time: string;
  description: string;
}

export interface Combat {
  participants: string[];
  currentIndex: number;
  round: number;
}

export interface LogEntry {
  timestamp: string;
  message: string;
}

export interface SessionMeta {
  ruleMode: "" | "narrative" | "hybrid";
  scenarioName: string;
}

export interface GameState {
  players: Record<string, Player>;
  npcs: Record<string, Npc>;
  clues: Clue[];
  scene: Scene;
  combat: Combat | null;
  log: LogEntry[];
  session: SessionMeta;
}

export const EMPTY_STATE: GameState = {
  players: {},
  npcs: {},
  clues: [],
  scene: { location: "", time: "", description: "" },
  combat: null,
  log: [],
  session: { ruleMode: "", scenarioName: "" },
};

export const NUMERIC_FIELDS = new Set([
  "hp", "maxHp", "san", "maxSan", "mp", "maxMp", "luck",
]);

export const TEXT_FIELDS = new Set(["notes", "location"]);

export const ARRAY_FIELDS = new Set(["status"]);

export interface ToolDetails<A, R> {
  arguments: A;
  result: R;
}
