/**
 * deepseek-tou-footer — DeepSeek 峰谷计费状态栏扩展
 *
 * 对 provider === "deepseek" 的所有模型，把状态栏（底部 footer）的会话总成本
 * 按峰谷电价规则重算显示（只影响状态栏显示，不修改任何模型/计费数据本身）：
 *
 *   - 峰时：工作日（周一至周五，UTC）01:00–04:00 与 06:00–10:00
 *           （半开区间 [start, end)，与 DeepSeek V4 官方定价页
 *            "Peak hours are 01:00 - 04:00 and 06:00 - 10:00 UTC,
 *             Monday through Friday" 一致）→ 价格 ×2
 *   - 谷时：其余时间（含周末）→ 基础价（models.json / 目录中 cost）
 *
 * 计费归属：按每条 deepseek 请求的“发生时刻（UTC）”判定峰/谷（与真实按量计费
 * 一致）。历史谷时消息不会因为现在处于峰时而变贵；峰谷边界切换后新请求才按新档。
 *
 * 显示方式：
 *   - 用 ctx.ui.setFooter 复刻内置底栏的三行布局（目录/git分支/会话名行、
 *     tokens/缓存/成本/上下文行、其它扩展 setStatus 状态行），只把成本汇总
 *     替换为峰谷重算值。
 *   - DeepSeek 官方以人民币结算（https://api-docs.deepseek.com/zh-cn/quick_start/pricing/）：
 *     当会话存在 deepseek 用量时，其成本不再使用目录/模型元数据中的（美元系）
 *     单价，而是按“官方人民币谷时单价 × tokens × 峰谷倍率”在状态栏内重算，
 *     金额前缀改用 ¥（其余无 deepseek 用量时保持内置 $ 外观）。仅影响状态栏，
 *     不修改任何模型 cost 元数据（/session 等仍按原有记录）。
 *   - 当会话存在 deepseek 成本时，成本数字按“当前档位”着色：
 *       峰时 → 红色（error）；谷时 → 绿色（success）。
 *     若环境不支持颜色，退化为在成本数字后附加短标「峰×2 / 谷」。
 *   - 其余位置（/session 面板、单条消息成本）保持原始记录口径，不做改动。
 *
 * 人民币单价表见 DEEPSEEK_CNY_RATES（谷/空闲时段单价，元/百万 tokens；峰时=×2）。
 * 表中没有的 deepseek 模型 id（如自建代理模型）回退用其存储成本 × 峰谷倍率。
 *
 * 已知与内置底栏的差异：无法通过扩展 API 读取内部标记，故不显示
 * “(auto)”自动压缩、实验特性 “xp”、订阅 “(sub)” 后缀；摘要/压缩/tool 用量
 * 无法归属模型，按其发生时若当前模型为 deepseek 且处于峰时则计入 ×2，否则基础价。
 *
 * 开关：运行 /ds-tou 可切换启用/停用（停用即恢复内置底栏）。
 * 参数：修改下方 PEAK_WINDOWS / PEAK_DAYS / PEAK_MULTIPLIER / DEEPSEEK_PROVIDER；
 *       人民币单价表见 DEEPSEEK_CNY_RATES（可自行增补自建模型）。
 * 彻底停用：将本文件改名为 *.disabled 后重启 pi。
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";

/* ------------------------- 可调参数 ------------------------- */

/** 适用 provider */
export const DEEPSEEK_PROVIDER = "deepseek";

/** 峰时窗口（UTC 小时，半开区间 [startHour, endHour)）。DeepSeek V4 官方：01:00–04:00、06:00–10:00 */
export const PEAK_WINDOWS = [
  { startHour: 1, endHour: 4 },
  { startHour: 6, endHour: 10 },
] as const;

/** 峰时适用日（UTC day-of-week，周一=1 … 周日=0）。官方口径：周一至周五 */
export const PEAK_DAYS = [1, 2, 3, 4, 5] as const;

/** 峰时倍率：所有费率（input/output/cacheRead/cacheWrite）×2 */
export const PEAK_MULTIPLIER = 2;

/** 成本前缀：会话含 deepseek（人民币计价）用量时用 ¥，否则保持内置 $ 外观 */
export const CNY_SYMBOL = "¥";

/**
 * DeepSeek 官方人民币谷/空闲时段单价（元/百万 tokens），峰时 = 谷时 ×2。
 * 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
 * 官方只有三档：缓存命中(cacheRead)/缓存未命中(input)/输出(output)；cacheWrite 不收费。
 * 自建/表中缺失的 deepseek 模型 id 会回退为按其存储成本计（例如 models.json 已配好
 * 人民币价的自定义模型），如需覆盖可在此追加：
 *   "<model id>": { input, output, cacheRead, cacheWrite },
 */
export const DEEPSEEK_CNY_RATES: Readonly<
  Record<
    string,
    { input: number; output: number; cacheRead: number; cacheWrite: number }
  >
> = {
  "deepseek-flash": { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0 },
  "deepseek-v4-flash": { input: 1, output: 4, cacheRead: 0.02, cacheWrite: 0 },
  "deepseek-v4-flash-vision-exp": {
    input: 1,
    output: 4,
    cacheRead: 0.02,
    cacheWrite: 0,
  },
  "deepseek-v4-pro": {
    input: 4.5,
    output: 13.5,
    cacheRead: 0.15,
    cacheWrite: 0,
  },
};

/* ------------------------- 峰谷时间逻辑 ------------------------- */

/** 指定时刻是否处于峰时窗口 */
export function isPeakDate(date: Date): boolean {
  if (!PEAK_DAYS.includes(date.getUTCDay() as (typeof PEAK_DAYS)[number]))
    return false;
  const hour = date.getUTCHours();
  return PEAK_WINDOWS.some((w) => hour >= w.startHour && hour < w.endHour);
}

/** 指定时刻适用的价格倍率（峰 ×2 / 谷 ×1） */
export function touMultiplierAt(date: Date): number {
  return isPeakDate(date) ? PEAK_MULTIPLIER : 1;
}

/** 距离下一次峰/谷边界切换的毫秒数 */
export function msUntilNextPhaseChange(now: Date): number {
  const candidates: number[] = [];
  // 检查未来 8 天内所有窗口边界（含周末日迭代，PEAK_DAYS 决定是否算峰时）
  for (let day = 0; day <= 8; day++) {
    for (const w of PEAK_WINDOWS) {
      for (const hour of [w.startHour, w.endHour]) {
        candidates.push(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + day,
            hour,
          ),
        );
      }
    }
  }
  const next = candidates
    .filter((t) => t > now.getTime())
    .sort((a, b) => a - b)[0];
  return next === undefined ? Number.MAX_SAFE_INTEGER : next - now.getTime();
}

/* ------------------------- 内置底栏小工具（复刻实现） ------------------------- */

export function formatTokens(count: number): string {
  return count < 1_000
    ? `${count}`
    : count < 10_000
      ? `${(count / 1_000).toFixed(1)}k`
      : count < 1_000_000
        ? `${Math.round(count / 1_000)}k`
        : count < 10_000_000
          ? `${(count / 1_000_000).toFixed(1)}M`
          : `${Math.round(count / 1_000_000)}M`;
}

export function formatCwdForFooter(
  cwd: string,
  home: string | undefined,
): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const relativeToHome = relative(resolvedHome, resolvedCwd);
  if (
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${sep}`) &&
      !isAbsolute(relativeToHome))
  ) {
    return relativeToHome === "" ? "~" : `~${sep}${relativeToHome}`;
  }
  return cwd;
}

export function sanitizeStatusText(text: string): string {
  return text
    .replace(/[\r\n\t]/g, " ")
    .replace(/ +/g, " ")
    .trim();
}

/* ------------------------- 统计与峰谷重算 ------------------------- */

interface UsageLike {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

interface FooterTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface TouStatsResult {
  totals: FooterTotals;
  /** 会话中 deepseek 消息的谷时基础成本合计（官方人民币单价或存储价，未乘峰时倍率），>0 表示存在 deepseek 用量 */
  deepseekBaseCost: number;
  /** 峰时窗口内发生的 deepseek 请求条数（信息用途） */
  peakRequests: number;
}

/** 条目发生时刻（毫秒）。优先条目自身时间戳，回退消息时间戳。 */
function entryTimeMs(entry: SessionEntry): number {
  if (typeof entry?.timestamp === "string") {
    const t = Date.parse(entry.timestamp);
    if (!Number.isNaN(t)) return t;
  }
  const msg = (entry as { message?: { timestamp?: unknown } }).message;
  if (typeof msg?.timestamp === "number" && msg.timestamp > 0)
    return msg.timestamp;
  return Date.now();
}

/** 查找官方人民币单价（谷/空闲时段）；无匹配返回 undefined */
export function cnyRateForModel(
  modelId: string | undefined,
):
  | { input: number; output: number; cacheRead: number; cacheWrite: number }
  | undefined {
  if (!modelId) return undefined;
  return DEEPSEEK_CNY_RATES[modelId];
}

/** 按官方人民币单价计算 usage 的基础成本（元） */
export function cnyCostForUsage(
  usage: UsageLike,
  rate: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  },
): number {
  return (
    (usage.input * rate.input +
      usage.output * rate.output +
      usage.cacheRead * rate.cacheRead +
      usage.cacheWrite * rate.cacheWrite) /
    1e6
  );
}

/**
 * 遍历会话条目累计 tokens，并按峰谷规则重算成本（仅状态栏口径，不改元数据）：
 * - deepseek assistant 消息：若官方人民币单价表命中该模型，按
 *   “官方谷时单价 × tokens × 该消息发生时刻(UTC)的倍率”重算；未命中（自建模型）
 *   则用其存储成本 × 倍率（此时默认 models.json 已是人民币价）。
 * - 压缩/branch 摘要用量无法归属模型：仅当“当前模型为 deepseek”时按当前模型
 *   的官方单价/存储成本 × 发生时刻倍率近似归属，否则按基础价。
 * - tool 用量与内置底栏一致按存储成本计入。
 *
 * @param activeModel 当前激活模型（用于归属摘要/压缩用量）
 */
export function computeTouStats(
  entries: SessionEntry[],
  activeModel?: { provider?: string; id?: string },
): TouStatsResult {
  const totals: FooterTotals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  };
  let deepseekBaseCost = 0;
  let peakRequests = 0;

  const addTokens = (usage: UsageLike) => {
    totals.input += usage.input;
    totals.output += usage.output;
    totals.cacheRead += usage.cacheRead;
    totals.cacheWrite += usage.cacheWrite;
  };

  // deepseek 条目：按模型官方人民币单价或存储成本计谷时基础价，再乘峰谷倍率
  const addDeepseek = (
    usage: UsageLike,
    modelId: string | undefined,
    mult: number,
  ) => {
    const rate = cnyRateForModel(modelId);
    const base = rate ? cnyCostForUsage(usage, rate) : usage.cost.total;
    deepseekBaseCost += base;
    totals.cost += base * mult;
    if (mult > 1) peakRequests++;
  };

  for (const entry of entries) {
    const type = entry?.type;
    if (type === "message") {
      const msg = (entry as { message?: { role?: string } }).message;
      const role = msg?.role;
      if (role === "assistant") {
        const m = entry as SessionEntry & {
          message: { provider?: string; model?: string; usage?: UsageLike };
        };
        const usage = m.message?.usage;
        if (!usage) continue;
        const isDeepseek = m.message.provider === DEEPSEEK_PROVIDER;
        addTokens(usage);
        if (isDeepseek) {
          addDeepseek(
            usage,
            m.message.model,
            touMultiplierAt(new Date(entryTimeMs(entry))),
          );
        } else {
          totals.cost += usage.cost.total;
        }
      } else if (role === "toolResult") {
        const usage = (entry as { message?: { usage?: UsageLike } }).message
          ?.usage;
        if (!usage) continue;
        addTokens(usage);
        totals.cost += usage.cost.total;
      }
    } else if (type === "branch_summary" || type === "compaction") {
      const usage = (entry as { usage?: UsageLike }).usage;
      if (!usage) continue;
      addTokens(usage);
      if (activeModel?.provider === DEEPSEEK_PROVIDER) {
        addDeepseek(
          usage,
          activeModel.id,
          touMultiplierAt(new Date(entryTimeMs(entry))),
        );
      } else {
        totals.cost += usage.cost.total;
      }
    }
  }
  return { totals, deepseekBaseCost, peakRequests };
}

/* ------------------------- 底栏渲染 ------------------------- */

type ThemeLike = { fg(color: string, text: string): string };
type FooterDataLike = {
  getGitBranch(): string | null;
  getExtensionStatuses(): ReadonlyMap<string, string>;
  onBranchChange(cb: () => void): () => void;
};

type StatPart = {
  text: string;
  style?: "dim" | "error" | "warning" | "success";
};

function colorsEnabled(theme: ThemeLike): boolean {
  try {
    return theme.fg("error", "x") !== "x";
  } catch {
    return false;
  }
}

function stylePart(theme: ThemeLike, part: StatPart): string {
  const color = part.style ?? "dim";
  return theme.fg(color, part.text);
}

/** 渲染内置底栏三行布局；唯一改动：成本行峰谷重算 + deepseek 成本按档位着色/短标 */
export function renderTouFooterLines(
  ctx: ExtensionContext,
  theme: ThemeLike,
  footerData: FooterDataLike,
  width: number,
): string[] {
  if (!ctx || width <= 0) return [""];

  const colorWorks = colorsEnabled(theme);
  const now = new Date();
  const peakNow = isPeakDate(now);
  const home = process.env.HOME || process.env.USERPROFILE;

  /* ---- 汇总 tokens / 成本（峰谷重算） ---- */
  let entries: SessionEntry[] = [];
  try {
    entries = ctx.sessionManager.getEntries() ?? [];
  } catch {
    entries = [];
  }
  const { totals, deepseekBaseCost } = computeTouStats(entries, {
    provider: ctx.model?.provider,
    id: ctx.model?.id,
  });
  const hasDeepseekCost = deepseekBaseCost > 0;
  const costSymbol = hasDeepseekCost ? CNY_SYMBOL : "$"; // deepseek 人民币计价 → ¥；其余保持内置 $
  const cacheUsed = totals.cacheRead > 0 || totals.cacheWrite > 0;

  /* ---- 缓存命中率：最新一条 assistant 消息（与内置 FooterComponent 一致） ---- */
  let cacheHitRate: number | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e?.type !== "message") continue;
    const m = e as SessionEntry & {
      message?: { role?: string; usage?: UsageLike };
    };
    if (m.message?.role === "assistant" && m.message.usage) {
      const pt =
        m.message.usage.input +
        m.message.usage.cacheRead +
        m.message.usage.cacheWrite;
      cacheHitRate =
        pt > 0 ? (m.message.usage.cacheRead / pt) * 100 : undefined;
      break;
    }
  }

  /* ---- 上下文占用 ---- */
  let contextUsage:
    | {
        tokens?: number | null;
        contextWindow?: number;
        percent?: number | null;
      }
    | undefined;
  try {
    contextUsage = ctx.getContextUsage?.() ?? undefined;
  } catch {
    contextUsage = undefined;
  }
  const contextWindow =
    contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
  const contextPercentValue = contextUsage?.percent ?? 0;
  const contextPercent =
    contextUsage?.percent === null ? "?" : contextPercentValue.toFixed(1);

  /* ---- 第 1 行：目录 / git 分支 / 会话名 ---- */
  let cwd = "";
  try {
    cwd = ctx.sessionManager?.getCwd?.() ?? ctx.cwd ?? "";
  } catch {
    cwd = ctx.cwd ?? "";
  }
  let pwd = formatCwdForFooter(cwd, home);
  const branch = footerData.getGitBranch();
  if (branch) pwd = `${pwd} (${branch})`;
  const sessionName = ctx.sessionManager.getSessionName?.() ?? undefined;
  if (sessionName) pwd = `${pwd} \u2022 ${sessionName}`;

  /* ---- 第 2 行左段：统计 + 成本 + 上下文 ---- */
  const statsParts: StatPart[] = [];
  if (totals.input)
    statsParts.push({ text: `\u2191${formatTokens(totals.input)}` });
  if (totals.output)
    statsParts.push({ text: `\u2193${formatTokens(totals.output)}` });
  if (totals.cacheRead)
    statsParts.push({ text: `R${formatTokens(totals.cacheRead)}` });
  if (totals.cacheWrite)
    statsParts.push({ text: `W${formatTokens(totals.cacheWrite)}` });
  if (cacheUsed && cacheHitRate !== undefined) {
    statsParts.push({ text: `CH${cacheHitRate.toFixed(1)}%` });
  }

  if (totals.cost > 0) {
    const costStr = `${costSymbol}${totals.cost.toFixed(3)}`;
    if (hasDeepseekCost && colorWorks) {
      // 峰时红 / 谷时绿
      statsParts.push({ text: costStr, style: peakNow ? "error" : "success" });
    } else {
      statsParts.push({ text: costStr });
      if (hasDeepseekCost) {
        // 不支持颜色：退化为短标
        statsParts.push({ text: peakNow ? "峰×2" : "谷" });
      }
    }
  }

  const contextPercentDisplay =
    contextPercent === "?"
      ? `?/${formatTokens(contextWindow)}`
      : `${contextPercent}%/${formatTokens(contextWindow)}`;
  const contextStyle: StatPart["style"] =
    contextPercentValue > 90
      ? "error"
      : contextPercentValue > 70
        ? "warning"
        : "dim";
  statsParts.push({ text: contextPercentDisplay, style: contextStyle });

  /* ---- 拼接与截断（镜像内置 FooterComponent 布局算法） ---- */
  const plainLeft = statsParts.map((p) => p.text).join(" ");
  const minPadding = 2;
  let statsLeft = plainLeft;
  let statsLeftWidth = visibleWidth(statsLeft);
  const leftTruncated = statsLeftWidth > width;
  if (leftTruncated) {
    statsLeft = truncateToWidth(statsLeft, width, "...");
    statsLeftWidth = visibleWidth(statsLeft);
  }

  const model = ctx.model;
  const modelName = model?.id || "no-model";
  let rightSideWithoutProvider = modelName;
  if (model?.reasoning) {
    const thinking = ctx.thinkingLevel ?? "off";
    rightSideWithoutProvider =
      thinking === "off"
        ? `${modelName} \u2022 thinking off`
        : `${modelName} \u2022 ${thinking}`;
  }
  let rightSide = rightSideWithoutProvider;
  let providerCount = 1;
  try {
    const avail = ctx.modelRegistry?.getAvailable?.() ?? [];
    providerCount =
      avail.length > 0
        ? new Set(avail.map((m) => m.provider)).size
        : new Set((ctx.modelRegistry?.getAll?.() ?? []).map((m) => m.provider))
            .size;
  } catch {
    providerCount = 1;
  }
  if (providerCount > 1 && model) {
    rightSide = `(${model.provider}) ${rightSideWithoutProvider}`;
    if (statsLeftWidth + minPadding + visibleWidth(rightSide) > width) {
      rightSide = rightSideWithoutProvider;
    }
  }
  const rightSideWidth = visibleWidth(rightSide);
  const totalNeeded = statsLeftWidth + minPadding + rightSideWidth;

  let statsLine: string;
  let rightTruncated = false;
  if (totalNeeded <= width) {
    const padding = " ".repeat(width - statsLeftWidth - rightSideWidth);
    statsLine = statsLeft + padding + rightSide;
  } else {
    const availableForRight = width - statsLeftWidth - minPadding;
    if (availableForRight > 0) {
      const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
      const truncatedRightWidth = visibleWidth(truncatedRight);
      rightTruncated = true;
      const padding = " ".repeat(
        Math.max(0, width - statsLeftWidth - truncatedRightWidth),
      );
      statsLine = statsLeft + padding + truncatedRight;
    } else {
      statsLine = statsLeft;
    }
  }

  /* ---- 最终上色 ---- */
  const canColorLeft =
    hasDeepseekCost && colorWorks && !leftTruncated && !rightTruncated;
  let statsLineStyled: string;
  if (canColorLeft) {
    // 逐段上色：deepseek 成本红/绿，其余 dim，右段 dim
    const coloredLeft = statsParts.map((p) => stylePart(theme, p)).join(" ");
    statsLineStyled =
      coloredLeft + theme.fg("dim", statsLine.slice(plainLeft.length));
  } else {
    statsLineStyled = theme.fg("dim", statsLine);
  }

  const lines: string[] = [
    truncateToWidth(theme.fg("dim", pwd), width, theme.fg("dim", "...")),
    statsLineStyled,
  ];

  /* ---- 第 3 行：其它扩展 setStatus 状态 ---- */
  let extensionStatuses: ReadonlyMap<string, string> = new Map();
  try {
    extensionStatuses = footerData.getExtensionStatuses?.() ?? new Map();
  } catch {
    extensionStatuses = new Map();
  }
  if (extensionStatuses.size > 0) {
    const statusLine = Array.from(extensionStatuses.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, text]) => sanitizeStatusText(text))
      .join(" ");
    lines.push(truncateToWidth(statusLine, width, theme.fg("dim", "...")));
  }
  return lines;
}

/* ------------------------- 扩展主体 ------------------------- */

export default function (pi: ExtensionAPI) {
  let enabled = true;
  let current: { ctx: ExtensionContext } | undefined;
  let latestTui: { requestRender?: () => void } | undefined;
  let latestTheme: ThemeLike | undefined;
  let boundaryTimer: ReturnType<typeof setTimeout> | undefined;

  function scheduleBoundaryTick() {
    if (!enabled || current?.ctx?.mode !== "tui") return;
    if (boundaryTimer) clearTimeout(boundaryTimer);
    const delay = msUntilNextPhaseChange(new Date());
    boundaryTimer = setTimeout(
      () => {
        boundaryTimer = undefined;
        // 峰/谷切换：请求重绘，让成本颜色/短标即时切换
        latestTui?.requestRender?.();
        scheduleBoundaryTick();
      },
      Math.min(delay, 2 ** 31 - 1) + 250,
    );
  }

  function installFooter(ctx: ExtensionContext) {
    current = { ctx };
    if (!enabled) return;
    if (ctx.mode !== "tui") return; // 仅 TUI 模式存在可替换底栏
    if (!ctx?.ui?.setFooter) return;
    ctx.ui.setFooter((tui, theme, footerData) => {
      latestTui = tui as { requestRender?: () => void };
      latestTheme = theme as ThemeLike;
      const unsub = footerData.onBranchChange(() =>
        latestTui?.requestRender?.(),
      );
      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          try {
            if (!current || !latestTheme) return [""];
            return renderTouFooterLines(
              current.ctx,
              latestTheme,
              footerData,
              width,
            );
          } catch {
            return [""];
          }
        },
      };
    });
  }

  pi.on("session_start", (_event, ctx) => {
    installFooter(ctx);
    scheduleBoundaryTick();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    // ctx 对象每次事件都是新实例，按会话身份（sessionManager）清理
    if (current && current.ctx.sessionManager === ctx.sessionManager) {
      current = undefined;
      if (boundaryTimer) {
        clearTimeout(boundaryTimer);
        boundaryTimer = undefined;
      }
    }
  });

  // 会话对象在事件间可能被替换：跟随最新 ctx（模型/思考档位/会话管理器均为最新）
  pi.on("model_select", (_event, ctx) => {
    if (current) current.ctx = ctx;
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (current) current.ctx = ctx;
  });
  pi.on("message_end", (_event, ctx) => {
    if (current) current.ctx = ctx;
  });
  pi.on("turn_end", (_event, ctx) => {
    if (current) current.ctx = ctx;
  });
  pi.on("session_info_changed", (_event, ctx) => {
    if (current) current.ctx = ctx;
  });

  pi.registerCommand("ds-tou", {
    description: "切换 DeepSeek 峰谷计费状态栏（启用/恢复内置底栏）",
    handler: async (_args, ctx) => {
      if (enabled) {
        enabled = false;
        if (boundaryTimer) {
          clearTimeout(boundaryTimer);
          boundaryTimer = undefined;
        }
        ctx.ui?.setFooter?.(undefined);
        ctx.ui?.notify?.(
          "DeepSeek 峰谷计费状态栏已停用，恢复内置底栏（/ds-tou 重新启用）",
          "info",
        );
      } else {
        enabled = true;
        installFooter(ctx);
        scheduleBoundaryTick();
        ctx.ui?.notify?.(
          "DeepSeek 峰谷计费状态栏已启用（峰时红色×2 / 谷时绿色）",
          "info",
        );
      }
    },
  });
}
