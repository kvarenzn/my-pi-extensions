/**
 * dsh-minimal-mode — 在 pi 中复刻 DeepSeek Harness「极简模式」（minimal preset）。
 *
 * 复刻目标（对应 deepseek-harness apps/cli/config/agent-presets/minimal/）：
 *   - system prompt：persona `complete: true` + `includeRuntimeContext: false`
 *     → 每一轮都恰好是 "You are a helpful software engineer assistant."
 *   - 工具目录：仅 `bash`（持久 shell）与 `str_replace_editor` 两个工具，
 *     schema / description / 错误文案 / 截断行为逐字复刻 DSH 实现。
 *   - 采样参数：temperature=1.0, top_p=0.95（官方评测档位），思考强度 max。
 *   - 可选「锚定」两阶段（仿 xiaobright/dsh-anchored-standard）：
 *     首个请求只见 bash + read，第一次成功工具调用后再放开其余工具。
 *
 * 用法：
 *   /dsh-minimal                严格极简模式（并尝试切到 opencode-go/deepseek-v4-pro）
 *   /dsh-minimal --no-model     严格极简模式但不切换模型
 *   /dsh-minimal --model p/id   指定要切换的模型
 *   /dsh-anchored               锚定两阶段（bash+read 起步，首调后放开 str_replace_editor）
 *   /dsh-anchored --full        锚定两阶段，首调后放开 pi 全部工具
 *   /dsh-off                    关闭复刻，恢复 pi 默认工具与提示词
 *   /dsh-status                 查看当前复刻状态
 * 启动参数：pi --dsh-minimal / --dsh-anchored（与命令一样会尝试切到 opencode-go/deepseek-v4-pro）
 */
import {
  withFileMutationQueue,
  createLocalBashOperations,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile, writeFile, stat, readdir, mkdir } from "node:fs/promises";
import { isAbsolute, resolve, dirname } from "node:path";

// ---------------------------------------------------------------------------
// DSH 极简模式常量（逐字复刻自 deepseek-harness）
// ---------------------------------------------------------------------------

const PERSONA_TEXT = "You are a helpful software engineer assistant.";

const DSH_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`;

const DSH_EDITOR_DESCRIPTION = `Custom editing tool for viewing, creating and editing files
* State is persistent across command calls and discussions with the user
* If \`path\` is a file, \`view\` displays the result of applying \`cat -n\`. If \`path\` is a directory, \`view\` lists non-hidden files and directories up to 2 levels deep
* The \`create\` command cannot be used if the specified \`path\` already exists as a file
* If a \`command\` generates a long output, it will be truncated and marked with \`<response clipped>\`

Notes for using the \`str_replace\` command:
* The \`old_str\` parameter should match EXACTLY one or more consecutive lines from the original file. Be mindful of whitespaces!
* If the \`old_str\` parameter is not unique in the file, the replacement will not be performed. Make sure to include enough context in \`old_str\` to make it unique
* The \`new_str\` parameter should contain the edited lines that should replace the \`old_str\``.trim();

const TRUNCATED_MESSAGE = "<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>";

const MAX_OUTPUT_CHARS = 16_000; // DSH 极简模式默认 maxOutputChars
const BASH_TIMEOUT_MS = 300_000; // DSH 极简模式 timeoutMs: 300000

// 以下三组文案与原生 DSH 的 tool-bash-persistent 逐字一致：
const SHELL_RESET_MESSAGE = "The persistent bash shell was reset; the next bash call starts from the workspace with a fresh current directory and environment.";
const LOST_PREFIX_MESSAGE = "<response clipped><NOTE>The beginning of this command output was dropped by the terminal scrollback limit. The following text is the earliest retained output.</NOTE>\n";
const TIMEOUT_MESSAGE_PREFIX = (seconds: number): string =>
  `Your command timed out after ${seconds} seconds or experienced an OOM error. Below is partial output:`;

// ---------------------------------------------------------------------------
// 工具 schema
// ---------------------------------------------------------------------------

const DSH_BASH_SCHEMA = Type.Object({
  command: Type.String({
    description: "The bash command to run. Relative path is preferred in the command.",
  }),
});

const PI_BASH_SCHEMA = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

const STR_REPLACE_SCHEMA = Type.Object({
  command: StringEnum(["view", "create", "str_replace", "insert"] as const),
  path: Type.String({
    description: "Absolute path to file or directory, e.g. `/repo/file.py` or `/repo`.",
  }),
  file_text: Type.Optional(Type.String({
    description: "Required parameter of `create` command, with the content of the file to be created.",
  })),
  insert_line: Type.Optional(Type.Integer({
    description: "Required parameter of `insert` command. The `new_str` will be inserted AFTER the line `insert_line` of `path`.",
  })),
  new_str: Type.Optional(Type.String({
    description: "Optional parameter of `str_replace` command containing the new string (if not given, no string will be added). Required parameter of `insert` command containing the string to insert.",
  })),
  old_str: Type.Optional(Type.String({
    description: "Required parameter of `str_replace` command containing the string in `path` to replace.",
  })),
  view_range: Type.Optional(Type.Array(Type.Integer(), {
    description: "Optional parameter of `view` command when `path` points to a file. If none is given, the full file is shown. If provided, the file will be shown in the indicated line number range, e.g. [11, 12] will show lines 11 and 12. Indexing at 1 to start. Setting `[start_line, -1]` shows all lines from `start_line` to the end of the file.",
  })),
});
type StrReplaceParams = Static<typeof STR_REPLACE_SCHEMA>;

// ---------------------------------------------------------------------------
// 持久 bash shell（复刻 DSH 的 persistent shell 语义：状态跨调用保留）
// ---------------------------------------------------------------------------

interface ShellHandle {
  child: ChildProcessWithoutNullStreams;
  queue: Promise<unknown>;
  seq: number;
}
const shells = new Map<string, ShellHandle>();
const localBashOps = createLocalBashOperations();

function killShellGroup(handle: ShellHandle): void {
  try {
    if (handle.child.pid !== undefined) process.kill(-handle.child.pid, "SIGKILL");
  } catch {
    try {
      handle.child.kill("SIGKILL");
    } catch {
      /* already dead */
    }
  }
}

function getShell(sessionId: string, cwd: string): ShellHandle {
  let handle = shells.get(sessionId);
  if (handle === undefined || handle.child.exitCode !== null || handle.child.signalCode !== null) {
    const child = spawn("bash", ["--noprofile", "--norc"], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.on("error", () => {});
    handle = { child, queue: Promise.resolve(), seq: 0 };
    shells.set(sessionId, handle);
  }
  return handle;
}

function maybeTruncateBash(content: string, maxOutputChars: number, incomplete: boolean): string {
  // 与原生 maybeTruncate 一致：保留头部；incomplete 时即使未超限也追加截断标记
  if (content.length <= maxOutputChars && !incomplete) return content;
  return content.length <= maxOutputChars
    ? content + TRUNCATED_MESSAGE
    : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE;
}

function renderCapturedBash(text: string, lostPrefix: boolean, exitCode?: number): string {
  const rendered = maybeTruncateBash(text, MAX_OUTPUT_CHARS, lostPrefix);
  const withPrefix = lostPrefix && text.length > 0
    ? LOST_PREFIX_MESSAGE + rendered
    : rendered;
  const marker = exitCode !== undefined && exitCode !== 0
    ? `[exit code: ${exitCode}]`
    : undefined;
  return marker === undefined ? withPrefix : withPrefix.length === 0 ? marker : `${withPrefix}\n${marker}`;
}

export async function execInShell(
  sessionId: string,
  cwd: string,
  command: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const handle = getShell(sessionId, cwd);
  const run = handle.queue.then(async () => {
    const seq = handle.seq++;
    const marker = `__DSH_END_d${seq}__`;
    // 追加一个唯一哨兵行（含退出码），用于从输出流中切分本次结果。
    handle.child.stdin.write(`${command}\nprintf '\\n${marker}%s\\n' "$?"\n`);

    let out = "";
    let lostPrefix = false; // 滚动缓冲截断过 → 头部输出已丢失
    let timedOut = false;
    const exitState: { exited: { code: number | null; signal: NodeJS.Signals | null } | null } = { exited: null };
    const onData = (data: Buffer): void => {
      out += data.toString("utf8");
      if (out.length > 1_000_000) { // 防爆内存；与原生 scrollback 限制语义一致
        out = out.slice(out.length - 1_000_000);
        lostPrefix = true;
      }
    };
    const onExit = (code: number | null, sig: NodeJS.Signals | null): void => {
      exitState.exited = { code, signal: sig };
    };
    handle.child.stdout.on("data", onData);
    handle.child.stderr.on("data", onData);
    handle.child.on("exit", onExit);

    const needle = `\n${marker}`;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      shells.delete(sessionId);
      killShellGroup(handle);
    }, BASH_TIMEOUT_MS);
    const onAbort = (): void => {
      shells.delete(sessionId);
      killShellGroup(handle);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    // 超时/退出路径：去掉尾部可能残留的半截哨兵（哨兵未完整打印时）
    const partial = (): string => out.replace(new RegExp(`\\n?__DSH_END_d${seq}__[\\s\\S]*$`), "");

    try {
      while (true) {
        if (signal?.aborted) throw new Error("aborted"); // 与原生一致：reset 后重抛中断
        if (timedOut) {
          // 与原生一致：不抛错，返回超时说明 + 部分输出 + 重置消息（shell 已重置，下次调用从工作区重新 spawn）
          return [
            TIMEOUT_MESSAGE_PREFIX(BASH_TIMEOUT_MS / 1000),
            renderCapturedBash(partial(), lostPrefix),
            SHELL_RESET_MESSAGE,
          ].join("\n");
        }
        const exited = exitState.exited;
        if (exited !== null) {
          // 与原生一致：不抛错，返回部分输出 + shell 状态 + 重置消息
          const status = exited.signal !== null
            ? `[shell killed by signal: ${exited.signal}]`
            : exited.code !== null
              ? `[shell exited: code ${exited.code}]`
              : "[shell exited]";
          return [
            renderCapturedBash(partial(), lostPrefix),
            status,
            SHELL_RESET_MESSAGE,
          ].filter((part) => part.length > 0).join("\n");
        }
        const idx = out.lastIndexOf(needle);
        if (idx >= 0) {
          const rest = out.slice(idx + needle.length);
          const nl = rest.indexOf("\n");
          if (nl >= 0) {
            const code = Number.parseInt(rest.slice(0, nl), 10);
            // 与原生一致：非零退出码不抛错，仅追加 [exit code: N]
            return renderCapturedBash(out.slice(0, idx), lostPrefix, code);
          }
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
      }
    } finally {
      clearTimeout(timeoutTimer);
      signal?.removeEventListener("abort", onAbort);
      handle.child.stdout.removeListener("data", onData);
      handle.child.stderr.removeListener("data", onData);
      handle.child.removeListener("exit", onExit);
      if (handle.child.exitCode !== null || handle.child.signalCode !== null) {
        shells.delete(sessionId); // 被超时/中断杀死，下次调用重开
      }
    }
  });
  handle.queue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// str_replace_editor（复刻 DSH 实现：view/create/str_replace/insert）
// ---------------------------------------------------------------------------

function maybeTruncate(content: string, maxOutputChars: number): string {
  return content.length <= maxOutputChars
    ? content
    : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE;
}

function codepointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredForCommand(
  value: string | undefined,
  parameter: string,
  command: string,
): string {
  if (value === undefined) throw new Error(`Parameter \`${parameter}\` is required for command: ${command}`);
  return value;
}

function resolveTarget(path: string): string {
  if (path.trim().length === 0) throw new Error("path must be a non-empty string");
  if (!isAbsolute(path)) {
    throw new Error(`The path ${path} is not an absolute path, it should start with \`/\`. Maybe you meant /${path}?`);
  }
  return path;
}

async function statExisting(path: string, command: "view" | "str_replace" | "insert"): Promise<{ type: string }> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new Error(`The path ${path} does not exist. Please provide a valid path.`);
  }
  if (info.isDirectory() && command !== "view") {
    throw new Error(`The path ${path} is a directory and only the \`view\` command can be used on directories`);
  }
  return { type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other" };
}

function formatFileView(path: string, content: string, maxOutputChars: number, viewRange: number[] | undefined): string {
  const allLines = content.split("\n");
  let lines = allLines;
  let initialLine = 1;
  let finalLine: number | undefined;
  let prompt = `Here's the content of ${path} with line numbers (which has a total of ${allLines.length} lines)`;
  if (viewRange !== undefined) {
    const [requestedInitialLine, requestedFinalLine] = viewRange;
    if (
      viewRange.length !== 2
      || requestedInitialLine === undefined
      || requestedFinalLine === undefined
      || !viewRange.every(Number.isInteger)
    ) {
      throw new Error("Invalid `view_range`. It should be a list of two integers.");
    }
    initialLine = requestedInitialLine;
    finalLine = requestedFinalLine;
    if (initialLine < 1 || initialLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its first element \`${initialLine}\` should be within the range of lines of the file: [1, ${allLines.length}]`,
      );
    }
    if (finalLine > allLines.length) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be smaller than the number of lines in the file: \`${allLines.length}\``,
      );
    }
    if (finalLine !== -1 && finalLine < initialLine) {
      throw new Error(
        `Invalid \`view_range\`: [${viewRange.join(", ")}]. Its second element \`${finalLine}\` should be larger or equal than its first \`${initialLine}\``,
      );
    }
    lines = finalLine === -1
      ? allLines.slice(initialLine - 1)
      : allLines.slice(initialLine - 1, finalLine);
    prompt += ` with view_range=[${initialLine}, ${finalLine}]`;
  }
  const numbered = lines
    .map((line, index) => `${String(initialLine + index).padStart(6, " ")}  ${line}`)
    .join("\n");
  return maybeTruncate(`${prompt}:\n${numbered}\n`, maxOutputChars);
}

async function listDirectory(path: string, maxOutputChars: number): Promise<string> {
  const rows: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "__pycache__") continue;
      const full = resolve(dir, entry.name);
      const type = entry.isDirectory() ? "d" : entry.isFile() ? "f" : "?";
      rows.push(`${type}\t${full}`);
      if (entry.isDirectory() && depth < 2) await visit(full, depth + 1);
    }
  }
  rows.push(`d\t${path}`);
  await visit(path, 1);
  rows.sort((left, right) => codepointCompare(left.slice(left.indexOf("\t") + 1), right.slice(right.indexOf("\t") + 1)));
  const listing = maybeTruncate(rows.join("\n") + "\n", maxOutputChars);
  return `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items, node_modules, and Python cache directories:\n${listing}\n`;
}

function matchOffsets(content: string, search: string): number[] {
  const offsets: number[] = [];
  let offset = 0;
  while (true) {
    const match = content.indexOf(search, offset);
    if (match < 0) return offsets;
    offsets.push(match);
    offset = match + search.length;
  }
}

function lineNumbersAt(content: string, offsets: readonly number[]): number[] {
  let line = 1;
  let cursor = 0;
  return offsets.map((offset) => {
    while (cursor < offset) {
      if (content[cursor] === "\n") line += 1;
      cursor += 1;
    }
    return line;
  });
}

async function executeEditor(params: StrReplaceParams, cwd: string): Promise<string> {
  const { command, path } = params;
  const target = resolveTarget(path);
  switch (command) {
    case "view": {
      const info = await statExisting(target, "view");
      if (info.type === "directory") {
        if (params.view_range !== undefined) {
          throw new Error("The `view_range` parameter is not allowed when `path` points to a directory.");
        }
        return listDirectory(target, MAX_OUTPUT_CHARS);
      }
      if (info.type !== "file") {
        throw new Error(`cannot view "${target}": not a regular file or directory`);
      }
      const content = await readFile(target, "utf8");
      return formatFileView(target, content, MAX_OUTPUT_CHARS, params.view_range);
    }
    case "create": {
      const fileText = requiredForCommand(params.file_text, "file_text", "create");
      return withFileMutationQueue(target, async () => {
        try {
          await stat(target);
          throw new Error(`File already exists at: ${target}. Cannot overwrite files using command \`create\`.`);
        } catch (error) {
          if (error instanceof Error && error.message.startsWith("File already exists")) throw error;
          // ENOENT → 正常创建
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, fileText, "utf8");
        return `New file created successfully at: ${target}`;
      });
    }
    case "str_replace": {
      const oldStr = requiredForCommand(params.old_str, "old_str", "str_replace");
      const newStr = params.new_str ?? "";
      const info = await statExisting(target, "str_replace");
      if (info.type !== "file") {
        throw new Error(`cannot edit "${target}": not a regular file`);
      }
      return withFileMutationQueue(target, async () => {
        const before = await readFile(target, "utf8");
        const offsets = matchOffsets(before, oldStr);
        const offset = offsets[0];
        if (offset === undefined) {
          throw new Error(`No replacement was performed, old_str \`${oldStr}\` did not appear verbatim in ${target}.`);
        }
        if (offsets.length > 1) {
          const lines = lineNumbersAt(before, offsets);
          throw new Error(
            `No replacement was performed. Multiple occurrences of old_str \`${oldStr}\` in lines [${lines.join(", ")}]. Please ensure it is unique`,
          );
        }
        const after = before.slice(0, offset) + newStr + before.slice(offset + oldStr.length);
        await writeFile(target, after, "utf8");
        return `The file ${target} has been edited successfully.`;
      });
    }
    case "insert": {
      if (params.insert_line === undefined) {
        throw new Error("Parameter `insert_line` is required for command: insert");
      }
      const value = requiredForCommand(params.new_str, "new_str", "insert");
      const info = await statExisting(target, "insert");
      if (info.type !== "file") {
        throw new Error(`cannot insert into "${target}": not a regular file`);
      }
      return withFileMutationQueue(target, async () => {
        const before = await readFile(target, "utf8");
        const lines = before.split("\n");
        if (!Number.isInteger(params.insert_line) || params.insert_line! < 0 || params.insert_line! > lines.length) {
          throw new Error(
            `Invalid \`insert_line\` parameter: ${params.insert_line}. It should be within the range of lines of the file: [0, ${lines.length}]`,
          );
        }
        const after = [
          ...lines.slice(0, params.insert_line),
          ...value.split("\n"),
          ...lines.slice(params.insert_line),
        ].join("\n");
        await writeFile(target, after, "utf8");
        return `The file ${target} has been edited successfully.`;
      });
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// 模式状态
// ---------------------------------------------------------------------------

type Mode = "off" | "minimal" | "anchored";
let mode: Mode = "off";
let anchoredFull = false;
let anchoredPromoted = false;

const MINIMAL_TOOLS = ["bash", "str_replace_editor"];
const ANCHORED_BOOTSTRAP_TOOLS = ["bash", "read"];

function allowedTools(): string[] {
  if (mode === "minimal") return MINIMAL_TOOLS;
  if (mode === "anchored") {
    if (anchoredFull && anchoredPromoted) {
      const all = piRef.getAllTools().map((t) => t.name);
      return [...new Set([...all, ...MINIMAL_TOOLS])];
    }
    return anchoredPromoted ? MINIMAL_TOOLS : ANCHORED_BOOTSTRAP_TOOLS;
  }
  return ["read", "bash", "edit", "write"];
}

// ---------------------------------------------------------------------------
// bash 工具定义（按模式切换语义：持久 shell vs pi 原生一次性 shell）
// ---------------------------------------------------------------------------

function createBashDefinition(): ToolDefinition<any, unknown, unknown> {
  const persistent = mode !== "off";
  return {
    name: "bash",
    label: "bash",
    description: persistent
      ? DSH_BASH_DESCRIPTION
      : "Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.",
    promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
    parameters: persistent ? DSH_BASH_SCHEMA : PI_BASH_SCHEMA,
    async execute(_toolCallId, params: { command: string; timeout?: number }, signal, _onUpdate, ctx: ExtensionContext) {
      const sessionId = ctx.sessionManager.getSessionId();
      if (persistent) {
        return {
          content: [{ type: "text", text: await execInShell(sessionId, ctx.cwd, params.command, signal) }],
          details: {},
        };
      }
      // off 模式：与 pi 内置 bash 行为一致（每次调用全新 shell）
      const output = await new Promise<string>((resolvePromise, rejectPromise) => {
        const chunks: Buffer[] = [];
        localBashOps.exec(params.command, ctx.cwd, {
          onData: (data) => chunks.push(data),
          signal,
          timeout: params.timeout,
        }).then(
          ({ exitCode }) => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (exitCode !== 0 && exitCode !== null) {
              rejectPromise(new Error(`${text}\nCommand exited with code ${exitCode}`));
            } else {
              resolvePromise(text || "(no output)");
            }
          },
          rejectPromise,
        );
      });
      return { content: [{ type: "text", text: output }], details: {} };
    },
  };
}

let piRef!: ExtensionAPI;

// ---------------------------------------------------------------------------
// 扩展主体
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI): void {
  piRef = pi;

  // 注册工具（bash 覆盖内置同名工具；off 模式下行为与内置一致）
  pi.registerTool(createBashDefinition());
  pi.registerTool({
    name: "str_replace_editor",
    label: "str_replace_editor",
    description: DSH_EDITOR_DESCRIPTION,
    parameters: STR_REPLACE_SCHEMA,
    async execute(_toolCallId, params: StrReplaceParams, _signal, _onUpdate, ctx: ExtensionContext) {
      return {
        content: [{ type: "text", text: await executeEditor(params, ctx.cwd) }],
        details: {},
      };
    },
  });

  function applyMode(next: Mode, opts: { model?: string | null; full?: boolean } = {}): void {
    const prev = mode;
    mode = next;
    anchoredFull = !!opts.full;
    anchoredPromoted = false;
    pi.registerTool(createBashDefinition()); // 按模式换 schema/语义
    pi.setActiveTools(allowedTools());
    if (next !== "off") pi.setThinkingLevel("max");
    void (async () => {
      if (next !== "off" && opts.model !== null) {
        const spec = (opts.model ?? "opencode-go/deepseek-v4-pro").split("/");
        const [provider, modelId] = spec.length === 2 ? spec : ["opencode-go", spec[0]];
        const model = ctxRef.modelRegistry.find(provider, modelId);
        if (model) {
          const ok = await pi.setModel(model);
          ctxRef.ui.notify(ok ? `模型已切换: ${provider}/${modelId}` : `模型 ${provider}/${modelId} 缺少 API key`, ok ? "info" : "warning");
        } else {
          ctxRef.ui.notify(`未找到模型 ${provider}/${modelId}`, "warning");
        }
      }
      const label = next === "minimal" ? "极简模式" : next === "anchored" ? "锚定两阶段" : "已关闭";
      ctxRef.ui.notify(`DSH 复刻: ${label}（工具: ${allowedTools().join(", ")}）`, "info");
      if (prev === "off" && next !== "off") {
        ctxRef.ui.notify("System prompt 已替换为: You are a helpful software engineer assistant.", "info");
      }
    })();
  }

  let ctxRef!: ExtensionContext;

  pi.registerFlag("dsh-minimal", {
    description: "启动即启用 DSH 极简模式复刻",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("dsh-anchored", {
    description: "启动即启用 DSH 锚定两阶段模式",
    type: "boolean",
    default: false,
  });

  pi.on("session_start", (_event, ctx) => {
    ctxRef = ctx;
    if (pi.getFlag("dsh-minimal") && mode === "off") {
      applyMode("minimal", { model: "opencode-go/deepseek-v4-pro" });
    }
    if (pi.getFlag("dsh-anchored") && mode === "off") {
      applyMode("anchored", { model: "opencode-go/deepseek-v4-pro", full: true });
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    const handle = shells.get(ctx.sessionManager.getSessionId());
    if (handle) {
      killShellGroup(handle);
      shells.delete(ctx.sessionManager.getSessionId());
    }
  });

  // 每轮替换 system prompt —— 等价于 DSH persona `complete: true` 的最终形态
  pi.on("before_agent_start", (_event) => {
    if (mode === "off") return;
    return { systemPrompt: PERSONA_TEXT };
  });

  // 采样参数对齐官方评测档位：topp=0.95, temperature=1.0
  pi.on("before_provider_request", (event) => {
    if (mode === "off") return;
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload && typeof payload === "object") {
      if ("temperature" in payload) payload.temperature = 1.0;
      if ("top_p" in payload) payload.top_p = 0.95;
    }
    return payload;
  });

  // 锚定模式：第一次成功工具调用后放开工具目录
  pi.on("tool_execution_end", (event) => {
    if (mode !== "anchored" || anchoredPromoted || event.isError) return;
    anchoredPromoted = true;
    pi.setActiveTools(allowedTools());
    ctxRef.ui.notify(`锚定提升: 工具目录已放开 → ${allowedTools().join(", ")}`, "info");
  });

  // 兜底：阻止活动集合之外的工具
  pi.on("tool_call", (event) => {
    if (mode === "off") return;
    const allowed = new Set(allowedTools());
    if (!allowed.has(event.toolName)) {
      return { block: true, reason: `当前处于 DSH ${mode === "minimal" ? "极简" : "锚定"}模式，仅允许工具: ${allowedTools().join(", ")}` };
    }
  });

  // -------------------------------------------------------------------------
  // 命令
  // -------------------------------------------------------------------------

  pi.registerCommand("dsh-minimal", {
    description: "启用 DSH 极简模式复刻（persona 完整提示词 + bash/str_replace_editor + max 思考 + 官方采样）",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const noModel = /\b--no-model\b/.test(args ?? "");
      const modelMatch = /--model\s+(\S+)/.exec(args ?? "");
      applyMode("minimal", { model: noModel ? null : (modelMatch?.[1] ?? "opencode-go/deepseek-v4-pro") });
    },
  });

  pi.registerCommand("dsh-anchored", {
    description: "启用锚定两阶段（bash+read 起步，首调后放开；--full 放开全部工具）",
    handler: async (args, ctx) => {
      ctxRef = ctx;
      const noModel = /\b--no-model\b/.test(args ?? "");
      const modelMatch = /--model\s+(\S+)/.exec(args ?? "");
      applyMode("anchored", {
        full: /\b--full\b/.test(args ?? ""),
        model: noModel ? null : (modelMatch?.[1] ?? "opencode-go/deepseek-v4-pro"),
      });
    },
  });

  pi.registerCommand("dsh-off", {
    description: "关闭 DSH 复刻，恢复 pi 默认提示词与工具",
    handler: async (_args, ctx) => {
      ctxRef = ctx;
      applyMode("off");
    },
  });

  pi.registerCommand("dsh-status", {
    description: "查看 DSH 复刻当前状态",
    handler: async (_args, ctx) => {
      const model = ctx.model;
      ctx.ui.notify(
        `模式: ${mode === "off" ? "关闭" : mode}\n工具: ${allowedTools().join(", ")}\n模型: ${model ? `${model.provider}/${model.id}` : "未设置"}\n思考: ${ctx.thinkingLevel}\n提示词: ${mode === "off" ? "pi 默认" : PERSONA_TEXT}`,
        "info",
      );
    },
  });
}
