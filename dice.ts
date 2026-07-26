/**
 * Dice Tool - Roll dice with various RPG expression syntaxes
 *
 * Supports:
 *   - Basic: d20, 3d6, d% (1d100)
 *   - Arithmetic: 2d6+3, 1d4-1, 1d6+1d4
 *   - Multiplication: 5*3d6, 2*2d8+3 (multiplication has precedence over +/-)
 *   - Keep highest (khN): 4d6kh3 (keep highest 3 of 4d6)
 *   - Keep lowest (klN): 2d20kl1 (D&D disadvantage)
 *   - Exploding (!): 1d6! (roll max → roll again, accumulate)
 *   - CoC penalty (p): 1d100p (tens die twice, take higher)
 *   - CoC bonus (b): 1d100b (tens die twice, take lower)
 *   - Combinations: 3d6!kh2 (exploding, keep highest 2)
 *
 * Loaded Dice (灌铅骰子):
 *   Set env LOADED_DICE=1 to enable. When active, the tool prompts the user
 *   via TUI input dialogs for each dice term's values instead of using random.
 *   The LLM never sees the prompts — results are formatted identically to
 *   normal rolls. Useful for TTRPG "cheating" during LLM-as-GM sessions.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ──────── Types ────────

interface RollStep {
	/** Human-readable description of this term, e.g. "2d6", "4d6kh3", "3" */
	label: string;
	/** Raw rolls before any keep/drop filtering */
	rolls: number[];
	/** Rolls after keeping (if kh/kl was applied) */
	kept?: number[];
	/** Rolls that were dropped (if kh/kl was applied) */
	dropped?: number[];
	/** Subtotal for this step */
	total: number;
	/** Whether explosion occurred */
	exploded?: boolean;
	/** CoC penalty die */
	penalty?: boolean;
	/** CoC bonus die */
	bonus?: boolean;
}

interface DiceResult {
	expression: string;
	reason?: string;
	hiddenMode: "open" | "hide_result" | "hidden";
	steps: RollStep[];
	/** Operators between consecutive steps (length = steps.length - 1) */
	ops: string[];
	total: number;
}

// ──────── Tokenizer ────────

type TokenType =
	| "number"
	| "d"
	| "plus"
	| "minus"
	| "star"
	| "percent"
	| "explode"
	| "kh"
	| "kl"
	| "p"
	| "b"
	| "eof";

interface Token {
	type: TokenType;
	value?: number;
}

class Tokenizer {
	private pos = 0;

	constructor(private input: string) {}

	save(): number {
		return this.pos;
	}

	restore(pos: number): void {
		this.pos = pos;
	}

	peek(): Token {
		const saved = this.pos;
		const token = this.next();
		this.pos = saved;
		return token;
	}

	next(): Token {
		this.skipWhitespace();
		if (this.pos >= this.input.length) return { type: "eof" };

		const ch = this.input[this.pos].toLowerCase();

		if (ch === "+") {
			this.pos++;
			return { type: "plus" };
		}
		if (ch === "-") {
			this.pos++;
			return { type: "minus" };
		}
		if (ch === "*") {
			this.pos++;
			return { type: "star" };
		}
		if (ch === "%") {
			this.pos++;
			return { type: "percent" };
		}
		if (ch === "!") {
			this.pos++;
			return { type: "explode" };
		}
		if (ch === "d") {
			this.pos++;
			return { type: "d" };
		}
		if (ch === "p") {
			this.pos++;
			return { type: "p" };
		}
		if (ch === "b") {
			this.pos++;
			return { type: "b" };
		}

		if (ch === "k") {
			this.pos++;
			if (this.pos >= this.input.length) {
				throw new Error("'k' 后面需要 'h' 或 'l'");
			}
			const nextCh = this.input[this.pos].toLowerCase();
			if (nextCh === "h") {
				this.pos++;
				const n = this.readNumber();
				if (n === undefined) throw new Error("'kh' 后面需要数字，例如 kh3");
				if (n < 1) throw new Error("'kh' 后面的数字必须为正整数");
				return { type: "kh", value: n };
			}
			if (nextCh === "l") {
				this.pos++;
				const n = this.readNumber();
				if (n === undefined) throw new Error("'kl' 后面需要数字，例如 kl1");
				if (n < 1) throw new Error("'kl' 后面的数字必须为正整数");
				return { type: "kl", value: n };
			}
			throw new Error("'k' 后面需要 'h'（取最高）或 'l'（取最低）");
		}

		// Try to read a number
		const num = this.readNumber();
		if (num !== undefined) return { type: "number", value: num };

		throw new Error(`无法解析字符「${this.input[this.pos]}」`);
	}

	private skipWhitespace() {
		while (this.pos < this.input.length && /\s/.test(this.input[this.pos])) {
			this.pos++;
		}
	}

	private readNumber(): number | undefined {
		const start = this.pos;
		while (this.pos < this.input.length && /\d/.test(this.input[this.pos])) {
			this.pos++;
		}
		if (this.pos > start) {
			return parseInt(this.input.slice(start, this.pos), 10);
		}
		return undefined;
	}
}

// ──────── Loaded Dice State ────────

let loadedDiceQueue: number[] = [];
let loadedDiceEnabled = false;
/** Mutex to serialize loaded-dice evaluations (avoid race on global state + UI dialogs). */
let loadedDiceLock: Promise<void> = Promise.resolve();

// ──────── Dice Rolling Primitives ────────

function rollDie(sides: number): number {
	if (loadedDiceEnabled && loadedDiceQueue.length > 0) {
		return loadedDiceQueue.shift()!;
	}
	return Math.floor(Math.random() * sides) + 1;
}

function sum(arr: number[]): number {
	return arr.reduce((a, b) => a + b, 0);
}

// ──────── Dice Term Scanner (for loaded dice) ────────

interface DiceTermInfo {
	label: string;
	count: number;
	sides: number;
	hasExplode: boolean;
	keepHigh?: number;
	keepLow?: number;
	hasPenalty: boolean;
	hasBonus: boolean;
}

/** Lightweight scan: extract dice term metadata without rolling. */
function scanDiceTerms(expression: string): DiceTermInfo[] {
	const tokenizer = new Tokenizer(expression);
	const terms: DiceTermInfo[] = [];

	// First term
	const first = scanOneTerm(tokenizer);
	if (first) terms.push(first);

	// Remaining terms
	while (true) {
		const op = tokenizer.peek();
		if (op.type === "plus" || op.type === "minus" || op.type === "star") {
			tokenizer.next();
			const term = scanOneTerm(tokenizer);
			if (term) terms.push(term);
		} else {
			break;
		}
	}

	return terms;
}

/** Scan a single term: returns DiceTermInfo for dice terms, null for plain numbers. */
function scanOneTerm(tokenizer: Tokenizer): DiceTermInfo | null {
	const peek = tokenizer.peek();

	if (peek.type === "number") {
		const savedPos = tokenizer.save();
		tokenizer.next();
		const afterNum = tokenizer.peek();
		if (afterNum.type === "d" || afterNum.type === "percent") {
			tokenizer.restore(savedPos);
			return scanOneDiceTerm(tokenizer);
		}
		// Plain number — skip
		return null;
	}

	if (peek.type === "d" || peek.type === "percent") {
		return scanOneDiceTerm(tokenizer);
	}

	return null;
}

/** Scan a single dice term (e.g. "3d6", "d%", "4d6kh3"). Mirrors evaluateDiceTerm without rolling. */
function scanOneDiceTerm(tokenizer: Tokenizer): DiceTermInfo {
	let count: number;
	let sides: number;

	const peek = tokenizer.peek();
	if (peek.type === "number") {
		count = (tokenizer.next() as Token & { value: number }).value;
		if (count < 1) throw new Error("骰子数量必须为正整数");
	} else {
		count = 1;
	}

	const dToken = tokenizer.next();
	if (dToken.type !== "d") {
		throw new Error("掷骰表达式需要 'd'");
	}

	const sidesToken = tokenizer.peek();
	if (sidesToken.type === "percent") {
		tokenizer.next();
		sides = 100;
	} else if (sidesToken.type === "number") {
		sides = (tokenizer.next() as Token & { value: number }).value;
		if (sides < 2) throw new Error("骰子面数必须≥2");
	} else {
		throw new Error("骰子面数需要是正整数或 %");
	}

	// Parse suffixes
	let hasExplode = false;
	let keepHigh: number | undefined;
	let keepLow: number | undefined;
	let hasPenalty = false;
	let hasBonus = false;

	while (true) {
		const t = tokenizer.peek();
		if (t.type === "explode") {
			tokenizer.next();
			hasExplode = true;
		} else if (t.type === "kh") {
			tokenizer.next();
			keepHigh = t.value!;
		} else if (t.type === "kl") {
			tokenizer.next();
			keepLow = t.value!;
		} else if (t.type === "p") {
			tokenizer.next();
			hasPenalty = true;
		} else if (t.type === "b") {
			tokenizer.next();
			hasBonus = true;
		} else {
			break;
		}
	}

	// Build label
	let label = `${count}d`;
	label += sides === 100 ? "%" : sides;
	if (hasExplode) label += "!";
	if (keepHigh !== undefined) label += `kh${keepHigh}`;
	if (keepLow !== undefined) label += `kl${keepLow}`;
	if (hasPenalty) label += "p";
	if (hasBonus) label += "b";

	return { label, count, sides, hasExplode, keepHigh, keepLow, hasPenalty, hasBonus };
}

// ──────── Parser / Evaluator ────────

type DiceSuffix =
	| { kind: "explode" }
	| { kind: "kh"; value: number }
	| { kind: "kl"; value: number }
	| { kind: "p" }
	| { kind: "b" };

/** Parse and evaluate a single dice term (e.g., "3d6", "d20", "4d6kh3", "d%") */
function evaluateDiceTerm(tokenizer: Tokenizer): RollStep {
	// Parse optional count
	let count: number;
	let sides: number;
	const peek = tokenizer.peek();

	if (peek.type === "number") {
		count = (tokenizer.next() as Token & { value: number }).value;
		if (count < 1) throw new Error("骰子数量必须为正整数");
	} else {
		count = 1; // default
	}

	// Must have 'd'
	const dToken = tokenizer.next();
	if (dToken.type !== "d") {
		throw new Error("掷骰表达式需要 'd'（如 3d6、d20、d%）");
	}

	// Parse sides
	const sidesToken = tokenizer.peek();
	if (sidesToken.type === "percent") {
		tokenizer.next();
		sides = 100;
	} else if (sidesToken.type === "number") {
		sides = (tokenizer.next() as Token & { value: number }).value;
		if (sides < 2) throw new Error("骰子面数必须≥2");
	} else {
		throw new Error("骰子面数需要是正整数或 %");
	}

	// Parse suffixes
	const suffixes: DiceSuffix[] = [];
	while (true) {
		const t = tokenizer.peek();
		if (t.type === "explode") {
			tokenizer.next();
			suffixes.push({ kind: "explode" });
		} else if (t.type === "kh") {
			tokenizer.next();
			suffixes.push({ kind: "kh", value: t.value! });
		} else if (t.type === "kl") {
			tokenizer.next();
			suffixes.push({ kind: "kl", value: t.value! });
		} else if (t.type === "p") {
			tokenizer.next();
			suffixes.push({ kind: "p" });
		} else if (t.type === "b") {
			tokenizer.next();
			suffixes.push({ kind: "b" });
		} else {
			break;
		}
	}

	const hasExplode = suffixes.some((s) => s.kind === "explode");
	const keepHigh = suffixes.find((s) => s.kind === "kh");
	const keepLow = suffixes.find((s) => s.kind === "kl");
	const hasPenalty = suffixes.some((s) => s.kind === "p");
	const hasBonus = suffixes.some((s) => s.kind === "b");

	// Validate CoC penalty/bonus
	if (hasPenalty || hasBonus) {
		if (sides !== 100) {
			throw new Error("惩罚骰(p)/奖励骰(b) 仅适用于 d%");
		}
		if (count !== 1) {
			throw new Error("惩罚骰(p)/奖励骰(b) 仅适用于 1d%");
		}
	}

	// Build label
	let label = `${count}d`;
	label += sides === 100 ? "%" : sides;
	for (const s of suffixes) {
		if (s.kind === "explode") label += "!";
		else if (s.kind === "kh") label += `kh${s.value}`;
		else if (s.kind === "kl") label += `kl${s.value}`;
		else if (s.kind === "p") label += "p";
		else if (s.kind === "b") label += "b";
	}

	// ── CoC penalty/bonus ──
	if (hasPenalty || hasBonus) {
		// d%: tens die (0-9) and ones die (0-9)
		// Penalty: roll two tens dice, take higher (worse)
		// Bonus: roll two tens dice, take lower (better)
		const tens1 = rollDie(10) - 1; // 0-9
		const tens2 = rollDie(10) - 1; // 0-9
		const ones = rollDie(10) - 1; // 0-9

		const chosenTens = hasPenalty ? Math.max(tens1, tens2) : Math.min(tens1, tens2);
		const rawValue = chosenTens * 10 + ones;
		const resultValue = rawValue === 0 ? 100 : rawValue;

		const d100from = (t: number, o: number): number => {
			const v = t * 10 + o;
			return v === 0 ? 100 : v;
		};

		return {
			label,
			rolls: [d100from(tens1, ones)],
			total: resultValue,
			penalty: hasPenalty,
			bonus: hasBonus,
		};
	}

	// ── Normal / Exploding dice ──
	let allRolls: number[] = [];

	for (let i = 0; i < count; i++) {
		if (hasExplode) {
			// Exploding die: keep rolling while max value
			while (true) {
				const r = rollDie(sides);
				allRolls.push(r);
				if (r !== sides) break;
			}
		} else {
			allRolls.push(rollDie(sides));
		}
	}

	// Apply keep highest/lowest
	let kept = [...allRolls];
	let dropped: number[] = [];

	if (keepHigh) {
		const sorted = [...allRolls].sort((a, b) => b - a);
		kept = sorted.slice(0, keepHigh.value);
		dropped = sorted.slice(keepHigh.value);
	} else if (keepLow) {
		const sorted = [...allRolls].sort((a, b) => a - b);
		kept = sorted.slice(0, keepLow.value);
		dropped = sorted.slice(keepLow.value);
	}

	return {
		label,
		rolls: allRolls,
		kept: kept.length < allRolls.length ? kept : undefined,
		dropped: dropped.length > 0 ? dropped : undefined,
		total: sum(kept),
		exploded: hasExplode,
	};
}

/** Evaluate a term: either a dice expression or a plain number */
function evaluateTerm(tokenizer: Tokenizer): RollStep {
	const peek = tokenizer.peek();
	if (peek.type === "number") {
		// Could be just a number, or count of dice followed by 'd'
		// Peek ahead to see if next token is 'd'
		const savedPos = tokenizer.save();
		const numToken = tokenizer.next();
		const afterNum = tokenizer.peek();
		if (afterNum.type === "d" || afterNum.type === "percent") {
			// It's a dice with explicit count, go back
			tokenizer.restore(savedPos);
			return evaluateDiceTerm(tokenizer);
		}
		// It's a plain number
		const value = numToken.value!;
		if (value < 1) throw new Error("表达式中的数值必须为正整数");
		return {
			label: String(value),
			rolls: [value],
			total: value,
		};
	}
	if (peek.type === "d" || peek.type === "percent") {
		// Implicit count = 1
		return evaluateDiceTerm(tokenizer);
	}
	throw new Error("期望得到掷骰表达式或数字");
}

/** Parse and evaluate a full expression */
function evaluateExpression(expression: string): DiceResult {
	const tokenizer = new Tokenizer(expression);

	const steps: RollStep[] = [];
	const ops: string[] = [];

	// First term
	steps.push(evaluateTerm(tokenizer));

	// Remaining terms
	while (true) {
		const op = tokenizer.peek();
		if (op.type === "plus") {
			tokenizer.next();
			ops.push("+");
			steps.push(evaluateTerm(tokenizer));
		} else if (op.type === "minus") {
			tokenizer.next();
			ops.push("-");
			steps.push(evaluateTerm(tokenizer));
		} else if (op.type === "star") {
			tokenizer.next();
			ops.push("*");
			steps.push(evaluateTerm(tokenizer));
		} else {
			break;
		}
	}

	// Check for unexpected trailing content
	const eof = tokenizer.next();
	if (eof.type !== "eof") {
		throw new Error("表达式后有无法解析的内容");
	}

	// Calculate total with * precedence (multiplication before addition/subtraction)
	const values = steps.map((s) => s.total);

	let i = 0;
	let total = 0;

	// First term (and any chained multiplication after it)
	let currentValue = values[0];
	while (i < ops.length && ops[i] === "*") {
		currentValue *= values[i + 1];
		i++;
	}
	total += currentValue;

	// Remaining terms
	while (i < ops.length) {
		const op = ops[i]; // + or -
		i++;
		let value = values[i]; // term after the operator
		while (i < ops.length && ops[i] === "*") {
			value *= values[i + 1];
			i++;
		}
		if (op === "+") total += value;
		else total -= value;
	}

	return {
		expression,
		hiddenMode: "open",
		steps,
		ops,
		total,
	};
}

// ──────── Loaded Dice Prompting ────────

/**
 * Prompt the user for loaded dice values for a single dice term.
 * Returns array of queued values, or null if user cancelled.
 */
async function promptLoadedDice(
	ctx: {
		ui: {
			input: (title: string, placeholder?: string) => Promise<string | undefined>;
			notify: (message: string, type?: "info" | "warning" | "error") => void;
		};
	},
	term: DiceTermInfo,
): Promise<number[] | null> {
	const { label, count, sides, hasExplode, keepHigh, keepLow, hasPenalty, hasBonus } = term;

	// ── CoC penalty / bonus dice ──
	if (hasPenalty || hasBonus) {
		const mode = hasPenalty ? "惩罚骰(p)" : "奖励骰(b)";
		let result: number;

		while (true) {
			const input = await ctx.ui.input(
				`请输入 ${label} 的结果（${mode}）`,
				"1-100 之间的整数",
			);
			if (input === undefined || input.trim() === "") return null; // User cancelled

			const parsed = parseInt(input.trim(), 10);
			if (isNaN(parsed) || parsed < 1 || parsed > 100) {
				ctx.ui.notify(`无效输入: "${input.trim()}"，请输入 1-100 之间的整数。`, "error");
				continue;
			}
			result = parsed;
			break;
		}

		// Reverse-engineer the internal d10 rolls
		const rawValue = result === 100 ? 0 : result;
		const chosenTens = Math.floor(rawValue / 10);
		const ones = rawValue % 10;

		// rollDie(10) returns 1-10, we subtract 1 to get 0-9
		const onesDie = ones + 1; // rollDie(10) → ones

		let tensDie1: number;
		let tensDie2: number;

		if (hasPenalty) {
			// max(tens1, tens2) = chosenTens
			// One die must produce chosenTens, the other ≤ chosenTens
			tensDie1 = chosenTens + 1;
			tensDie2 = Math.floor(Math.random() * (chosenTens + 1)) + 1;
		} else {
			// min(tens1, tens2) = chosenTens
			// One die must produce chosenTens, the other ≥ chosenTens
			tensDie1 = chosenTens + 1;
			tensDie2 = Math.floor(Math.random() * (10 - chosenTens)) + chosenTens + 1;
		}

		return [tensDie1, tensDie2, onesDie];
	}

	// ── Keep highest / lowest dice ──
	if (keepHigh !== undefined || keepLow !== undefined) {
		const keepCount = keepHigh ?? keepLow!;
		const isKeepHigh = keepHigh !== undefined;
		let kept: number[];

		while (true) {
			const input = await ctx.ui.input(
				`请输入 ${label} 保留的 ${keepCount} 个值`,
				`逗号分隔，如 ${Array(keepCount).fill("?").join(",")}（范围 1-${sides}）`,
			);
			if (input === undefined || input.trim() === "") return null; // User cancelled

			const parsed = parseDiceInput(input.trim(), keepCount, keepCount, sides);
			if (!parsed) {
				ctx.ui.notify(`无效输入，请输入恰好 ${keepCount} 个 1-${sides} 的值，逗号分隔。`, "error");
				continue;
			}
			kept = parsed;
			break;
		}

		// Auto-generate the dropped value(s)
		const dropCount = count - keepCount;
		const dropped: number[] = [];
		for (let i = 0; i < dropCount; i++) {
			if (isKeepHigh) {
				// Dropped must be ≤ min(kept)
				const maxDrop = Math.min(...kept);
				dropped.push(Math.floor(Math.random() * maxDrop) + 1);
			} else {
				// Dropped must be ≥ max(kept)
				const minDrop = Math.max(...kept);
				dropped.push(Math.floor(Math.random() * (sides - minDrop + 1)) + minDrop);
			}
		}

		// Interleave kept and dropped for a natural-looking roll order
		const allValues = [...kept, ...dropped];
		// Shuffle so kept values aren't always first
		for (let i = allValues.length - 1; i > 0; i--) {
			const j = Math.floor(Math.random() * (i + 1));
			[allValues[i], allValues[j]] = [allValues[j], allValues[i]];
		}

		return allValues;
	}

	// ── Exploding dice ──
	if (hasExplode) {
		while (true) {
			const input = await ctx.ui.input(
				`请输入 ${label} 的所有骰子值`,
				`逗号分隔（范围 1-${sides}，至少 ${count} 个，可超过），如 6,1,6,2,3`,
			);
			if (input === undefined || input.trim() === "") return null; // User cancelled

			const parsed = parseDiceInput(input.trim(), count, undefined, sides);
			if (!parsed) {
				ctx.ui.notify(`无效输入，请输入至少 ${count} 个 1-${sides} 的值，逗号分隔。`, "error");
				continue;
			}
			return parsed;
		}
	}

	// ── Normal dice ──
	while (true) {
		const input = await ctx.ui.input(
			`请输入 ${label} 的结果`,
			`逗号分隔，如 ${count === 1 ? "?" : Array(count).fill("?").join(",")}（范围 1-${sides}）`,
		);
		if (input === undefined || input.trim() === "") return null; // User cancelled

		const parsed = parseDiceInput(input.trim(), count, count, sides);
		if (!parsed) {
			ctx.ui.notify(`无效输入，请输入恰好 ${count} 个 1-${sides} 的值，逗号分隔。`, "error");
			continue;
		}
		return parsed;
	}
}

/**
 * Parse comma-separated dice values. Validates count and range.
 * - minCount: minimum number of values required
 * - exactCount: if set, exactly this many values required (null = no upper limit beyond minCount)
 * - sides: each value must be 1..sides
 * Returns null on failure.
 */
function parseDiceInput(
	input: string,
	minCount: number,
	exactCount: number | undefined,
	sides: number,
): number[] | null {
	const parts = input.split(",").map((s) => s.trim()).filter((s) => s !== "");
	if (parts.length < minCount) return null;
	if (exactCount !== undefined && parts.length !== exactCount) return null;

	const values: number[] = [];
	for (const part of parts) {
		const n = parseInt(part, 10);
		if (isNaN(n) || n < 1 || n > sides) return null;
		values.push(n);
	}

	return values;
}

// ──────── Tool definition ────────

const DiceParams = Type.Object({
	expression: Type.String({ description: "掷骰表达式，如 d20、3d6、2d6+3、5*3d6、4d6kh3、1d6!、1d100p 等" }),
	reason: Type.Optional(Type.String({ description: "本次掷骰的原因（可选）" })),
	hidden: Type.Optional(
		Type.String({ description: "显示模式：'open' 明骰（默认），'hide_result' 隐藏结果仅显示原因，'hidden' 完全隐藏" }),
	),
});

function formatResultForLLM(result: DiceResult): string {
	const { expression, reason, steps, ops, total } = result;

	/** Format a single step's value for display */
	function formatStepValue(s: RollStep): string {
		if (/^\d+$/.test(s.label)) {
			return String(s.total);
		}
		if (s.kept) {
			return `(${s.kept.join("+")})`;
		}
		if (s.rolls.length === 1) {
			return String(s.rolls[0]);
		}
		if (s.rolls.length > 1) {
			return `(${s.rolls.join("+")})`;
		}
		return s.label;
	}

	// Build the expanded expression with proper operators
	const parts: string[] = [];
	parts.push(formatStepValue(steps[0]));
	for (let i = 0; i < ops.length; i++) {
		parts.push(` ${ops[i]} `);
		parts.push(formatStepValue(steps[i + 1]));
	}
	const expanded = parts.join("");

	let text: string;
	// Single die without modifiers = just show the value
	if (steps.length === 1 && steps[0].rolls.length === 1 && !steps[0].kept) {
		text = `${expression} = ${total}`;
	} else {
		text = `${expression} = ${expanded} = ${total}`;
	}

	if (reason) {
		text += ` (原因: ${reason})`;
	}

	return text;
}

// ──────── Export ────────

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "dice",
		label: "掷骰",
		description:
			"投掷虚拟骰子，支持各种 TRPG 掷骰表达式。语法：d20（1d20）、3d6、d%（1d100）、2d6+3、1d4-1、4d6kh3（取最高3个）、2d20kl1（取最低1个，即劣势）、1d6!（爆炸骰）、1d100p（CoC 惩罚骰）、1d100b（CoC 奖励骰）。后缀可组合：3d6!kh2",
		promptSnippet: "Roll dice using TRPG-style expressions",
		promptGuidelines: [
			"Use dice when the user wants to roll dice for TTRPGs like D&D, CoC, etc.",
			"The expression supports: d20, 3d6, d%, 2d6+3, 4d6kh3 (keep highest 3), 2d20kl1 (keep lowest 1, disadvantage), 1d6! (exploding dice), 1d100p (CoC penalty die), 1d100b (CoC bonus die), and combinations like 3d6!kh2",
		],
		parameters: DiceParams,

		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const { expression, reason, hidden } = params;

			// Normalize hidden mode
			let hiddenMode: "open" | "hide_result" | "hidden" = "open";
			if (hidden === "hidden") {
				hiddenMode = "hidden";
			} else if (hidden === "hide_result") {
				hiddenMode = "hide_result";
			} else if (hidden === "open" || hidden === undefined) {
				hiddenMode = "open";
			}

			if (!expression || typeof expression !== "string" || expression.trim().length === 0) {
				throw new Error("掷骰表达式不能为空。示例：d20、3d6、2d6+3、4d6kh3、1d6!");
			}

			const trimmedExpr = expression.trim();

			// Validate basic character set before parsing
			if (!/^[0-9dD%+\-!kKhHlLpPbB\s*]+$/.test(trimmedExpr)) {
				throw new Error(`掷骰表达式含有非法字符: "${trimmedExpr}"`);
			}

			// ── Loaded dice mode ──
			const useLoadedDice = process.env.LOADED_DICE === "1" && ctx.hasUI;

			if (useLoadedDice) {
				// Serialize: each call creates a new promise, waits for the
				// previous one, and resolves its own when the critical section
				// (prompting + evaluation) finishes.
				let release: () => void;
				const previousLock = loadedDiceLock;
				loadedDiceLock = new Promise<void>((resolve) => {
					release = resolve;
				});
				await previousLock;

				try {
					const diceTerms = scanDiceTerms(trimmedExpr);
					const allValues: number[] = [];

					for (const term of diceTerms) {
						const values = await promptLoadedDice(ctx, term);
						if (values === null) {
							// User cancelled — fall back to random for this whole roll
							allValues.length = 0;
							break;
						}
						allValues.push(...values);
					}

					if (allValues.length > 0) {
						loadedDiceQueue = allValues;
						loadedDiceEnabled = true;
					}
				} catch {
					// Scan or prompt failed — fall back to random
					loadedDiceQueue = [];
					loadedDiceEnabled = false;
				} finally {
					release!();
				}
			}

			try {
				const result = evaluateExpression(trimmedExpr);
				result.reason = reason;
				result.hiddenMode = hiddenMode;

				const llmText = formatResultForLLM(result);

				return {
					content: [{ type: "text", text: llmText }],
					details: {
						expression: result.expression,
						reason: result.reason,
						hiddenMode: result.hiddenMode,
						steps: result.steps,
						ops: result.ops,
						total: result.total,
						text: llmText,
					},
				};
			} finally {
				// Always reset loaded dice state after evaluation
				loadedDiceQueue = [];
				loadedDiceEnabled = false;
			}
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as DiceResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			// ── Hidden dice ──
			if (details.hiddenMode === "hidden") {
				return new Text(theme.fg("muted", "（过了一个暗骰）"), 0, 0);
			}
			if (details.hiddenMode === "hide_result") {
				let hiddenText = "（过了一个暗骰）";
				if (details.reason) hiddenText += ` (${details.reason})`;
				return new Text(theme.fg("muted", hiddenText), 0, 0);
			}

			// ── Visible dice ──
			const { expression, reason, steps, ops, total, hiddenMode } = details;
			let display = theme.fg("toolTitle", theme.bold("🎲 掷骰 ")) + theme.fg("accent", expression);

			if (reason) {
				display += theme.fg("muted", `  (${reason})`);
			}

			// Steps
			for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
				const step = steps[stepIdx];
				display += "\n  ";

				// Show operator before steps after the first
				if (stepIdx > 0 && ops && stepIdx - 1 < ops.length) {
					display += theme.fg("accent", `${ops[stepIdx - 1]} `);
				}

				const isPlainNumber = /^\d+$/.test(step.label);
				if (isPlainNumber) {
					display += theme.fg("muted", `${step.label}`);
				} else {
					display += theme.fg("muted", `${step.label} = `);
					const rollVals = step.kept ?? step.rolls;

					if (step.dropped && step.dropped.length > 0) {
						// With keep/drop
						display += theme.fg("dim", `[${step.rolls.join(", ")}]`);
						display += " → ";
						display += theme.fg("success", `${step.kept!.join(", ")}`);
						display += theme.fg("dim", ` (舍弃 ${step.dropped.join(", ")})`);
					} else if (rollVals.length > 1) {
						display += theme.fg("muted", `${rollVals.join(" + ")}`);
					} else {
						display += theme.fg("muted", `${rollVals[0]}`);
					}

					if (step.exploded && step.rolls.length > countDiceInExpression(step.label)) {
						display += theme.fg("warning", " 💥");
					}
					if (step.penalty) {
						display += theme.fg("warning", " ⚠惩罚骰");
					}
					if (step.bonus) {
						display += theme.fg("success", " ✨奖励骰");
					}

					display += theme.fg("dim", ` = ${step.total}`);
				}
			}

			// Total line
			display += "\n";
			display += theme.fg("bold", theme.fg("accent", `总和: ${total}`));

			return new Text(display, 0, 0);
		},
	});
}

/** Helper: count the number of dice in a label like "4d6kh3" → 4, "d%" → 1 */
function countDiceInExpression(label: string): number {
	const m = label.match(/^(\d+)d/i);
	if (m) return parseInt(m[1], 10);
	return 1; // no count prefix = 1 die
}
