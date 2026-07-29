import type { Count } from "./types";

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

function isEmpty(s: string): boolean {
  return s === "";
}

export function parseCount(input: number | string | undefined): Count {
  if (input === undefined) {
    return { approx: "", denominator: 1, numerator: 1 };
  }
  if (typeof input === "number") {
    if (!Number.isInteger(input) || input < 1) {
      throw new Error(`count 为整数时必须为正整数，收到 ${input}`);
    }
    return { approx: "", denominator: 1, numerator: input };
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    return { approx: "", denominator: 1, numerator: 1 };
  }
  const fracMatch = trimmed.match(/^(\d+)\/(\d+)$/);
  if (fracMatch) {
    const num = parseInt(fracMatch[1], 10);
    const den = parseInt(fracMatch[2], 10);
    if (den === 0) throw new Error(`count 分母不能为 0: "${trimmed}"`);
    if (num < 0) throw new Error(`count 分子不能为负: "${trimmed}"`);
    const g = gcd(num, den);
    return { approx: "", denominator: den / g, numerator: num / g };
  }
  return { approx: trimmed, denominator: 1, numerator: 0 };
}

function appendNonEmpty(a: string, b: string, add: boolean): string {
  if (isEmpty(a)) return (add ? "" : "- ") + b;
  if (isEmpty(b)) return a;
  return `${a} ${add ? "+" : "-"} ${b}`;
}

export function addCounts(a: Count, b: Count): Count {
  const newDen = a.denominator * b.denominator;
  const newNum = a.numerator * b.denominator + b.numerator * a.denominator;
  const g = gcd(newDen, newNum);
  return {
    approx: appendNonEmpty(a.approx, b.approx, true),
    denominator: newDen / g,
    numerator: newNum / g,
  };
}

export function subCounts(a: Count, b: Count): Count {
  const newDen = a.denominator * b.denominator;
  const newNum = a.numerator * b.denominator - b.numerator * a.denominator;
  const g = gcd(newDen, Math.abs(newNum));
  return {
    approx: appendNonEmpty(a.approx, b.approx, false),
    denominator: g === 0 ? 1 : newDen / g,
    numerator: g === 0 ? 0 : newNum / g,
  };
}

export function formatCount(c: Count): string {
  if (isEmpty(c.approx)) {
    if (c.numerator === 0) return "0";
    if (c.denominator === 1) return String(c.numerator);
    return `${c.numerator}/${c.denominator}`;
  }
  if (c.numerator === 0) return c.approx;
  if (c.denominator === 1) return `${c.approx} + ${c.numerator}`;
  return `${c.approx} + ${c.numerator}/${c.denominator}`;
}

export function countIsZero(c: Count): boolean {
  return isEmpty(c.approx) && c.numerator === 0;
}
