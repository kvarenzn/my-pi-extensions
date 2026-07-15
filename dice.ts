/**
 * Dice Tool - Roll dice with various RPG expression syntaxes
 *
 * Supports:
 *   - Basic: d20, 3d6, d% (1d100)
 *   - Arithmetic: 2d6+3, 1d4-1, 1d6+1d4
 *   - Keep highest (khN): 4d6kh3 (keep highest 3 of 4d6)
 *   - Keep lowest (klN): 2d20kl1 (D&D disadvantage)
 *   - Exploding (!): 1d6! (roll max → roll again, accumulate)
 *   - CoC penalty (p): 1d100p (tens die twice, take higher)
 *   - CoC bonus (b): 1d100b (tens die twice, take lower)
 *   - Combinations: 3d6!kh2 (exploding, keep highest 2)
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
	hidden: boolean;
	steps: RollStep[];
	total: number;
}

// ──────── Tokenizer ────────

type TokenType =
	| "number"
	| "d"
	| "plus"
	| "minus"
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

// ──────── Dice Rolling Primitives ────────

function rollDie(sides: number): number {
	return Math.floor(Math.random() * sides) + 1;
}

function sum(arr: number[]): number {
	return arr.reduce((a, b) => a + b, 0);
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
	const totalOps: Array<{ op: "+" | "-"; step: RollStep }> = [];

	// First term
	const first = evaluateTerm(tokenizer);
	totalOps.push({ op: "+", step: first });

	// Remaining +/- terms
	while (true) {
		const op = tokenizer.peek();
		if (op.type === "plus") {
			tokenizer.next();
			const step = evaluateTerm(tokenizer);
			totalOps.push({ op: "+", step });
		} else if (op.type === "minus") {
			tokenizer.next();
			const step = evaluateTerm(tokenizer);
			totalOps.push({ op: "-", step });
		} else {
			break;
		}
	}

	// Check for unexpected trailing content
	const eof = tokenizer.next();
	if (eof.type !== "eof") {
		throw new Error("表达式后有无法解析的内容");
	}

	// Calculate total
	let total = 0;
	for (const { op, step } of totalOps) {
		if (op === "+") total += step.total;
		else total -= step.total;
	}

	return {
		expression,
		hidden: false,
		steps: totalOps.map((o) => o.step),
		total,
	};
}

// ──────── Tool definition ────────

const DiceParams = Type.Object({
	expression: Type.String({ description: "掷骰表达式，如 d20、3d6、2d6+3、4d6kh3、1d6!、1d100p 等" }),
	reason: Type.Optional(Type.String({ description: "本次掷骰的原因（可选）" })),
	hidden: Type.Optional(
		Type.Boolean({ description: "是否为暗骰。若是，用户仅看到「（过了一个暗骰）」" }),
	),
});

function formatResultForLLM(result: DiceResult): string {
	const { expression, reason, steps, total } = result;

	const parts: string[] = [];
	for (const s of steps) {
		if (s.label.match(/^[0-9]+$/)) {
			parts.push(String(s.total));
		} else if (s.kept) {
			parts.push(`(${s.kept.join("+")})`);
		} else if (s.rolls.length === 1) {
			parts.push(String(s.rolls[0]));
		} else {
			parts.push(`(${s.rolls.join("+")})`);
		}
	}

	let text: string;
	const partsStr = parts.join(" + ");
	// Single die without modifiers = just show the value
	if (steps.length === 1 && steps[0].rolls.length === 1 && !steps[0].kept) {
		text = `${expression} = ${total}`;
	} else {
		text = `${expression} = ${partsStr} = ${total}`;
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

		execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { expression, reason, hidden } = params;

			if (!expression || typeof expression !== "string" || expression.trim().length === 0) {
				throw new Error("掷骰表达式不能为空。示例：d20、3d6、2d6+3、4d6kh3、1d6!");
			}

			const trimmedExpr = expression.trim();

			// Validate basic character set before parsing
			if (!/^[0-9dD%+\-!kKhHlLpPbB\s]+$/.test(trimmedExpr)) {
				throw new Error(`掷骰表达式含有非法字符: "${trimmedExpr}"`);
			}

			const result = evaluateExpression(trimmedExpr);
			result.reason = reason;
			result.hidden = hidden ?? false;

			const llmText = formatResultForLLM(result);

			return {
				content: [{ type: "text", text: llmText }],
				details: {
					expression: result.expression,
					reason: result.reason,
					hidden: result.hidden,
					steps: result.steps,
					total: result.total,
					text: llmText,
				},
			};
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as DiceResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			// ── Hidden dice ──
			if (details.hidden) {
				return new Text(theme.fg("muted", "（过了一个暗骰）"), 0, 0);
			}

			// ── Visible dice ──
			const { expression, reason, steps, total } = details;
			let display = theme.fg("toolTitle", theme.bold("🎲 掷骰 ")) + theme.fg("accent", expression);

			if (reason) {
				display += theme.fg("muted", `  (${reason})`);
			}

			// Steps
			for (const step of steps) {
				display += "\n  ";

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
