/**
 * Question Tool - Ask the user questions during execution
 *
 * Inspired by OpenCode's question tool. Supports:
 * - Single and multiple questions
 * - Single-select and multi-select options
 * - Custom text input ("Type something")
 * - Tab-based navigation for multi-question flows
 * - Proper LLM output formatting
 *
 * Usage: The LLM calls this tool with one or more questions, each with options.
 * The user picks from options or types a custom answer.
 * Answers are returned as arrays of labels for the LLM to use.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  Key,
  Markdown,
  type MarkdownTheme,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ─── Types ───────────────────────────────────────────────────────────────────

interface OptionDef {
  label: string;
  description?: string;
  preview?: string;
}

interface QuestionDef {
  question: string;
  header?: string;
  options: OptionDef[];
  multiple?: boolean;
}

interface QuestionAnswer {
  question: string;
  header: string;
  options: string[];
  answers: string[];
  wasCustom: boolean;
  customText?: string;
  note?: string;
}

interface ToolOutput {
  questions: QuestionDef[];
  answers: QuestionAnswer[];
  cancelled: boolean;
}

/** Internal option with the synthetic "Type something" entry */
interface RenderOption extends OptionDef {
  isOther?: boolean;
}

// ─── Schema ──────────────────────────────────────────────────────────────────

const OptionSchema = Type.Object({
  label: Type.String({ description: "Display text (1-5 words, concise)" }),
  description: Type.Optional(
    Type.String({ description: "Explanation of the choice" }),
  ),
  preview: Type.Optional(
    Type.String({ description: "Markdown preview shown when option is highlighted" }),
  ),
});

const QuestionSchema = Type.Object({
  question: Type.String({ description: "The complete question to ask" }),
  header: Type.Optional(
    Type.String({
      description:
        "Very short label for tab navigation (max 30 chars, defaults to Q1, Q2, …)",
    }),
  ),
  options: Type.Array(OptionSchema, {
    description: "Available choices for the user",
  }),
  multiple: Type.Optional(
    Type.Boolean({
      description:
        "Allow selecting multiple choices (default: false). When true, space toggles options and enter confirms.",
    }),
  ),
});

const InputSchema = Type.Object({
  questions: Type.Array(QuestionSchema, {
    description:
      "Questions to ask the user. Each question can have options to choose from.",
  }),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Build the message that tells the LLM what the user answered. */
function buildLLMOutput(
  questions: QuestionDef[],
  answers: QuestionAnswer[],
): string {
  const parts = questions.map((q, i) => {
    const a = answers[i];
    if (!a || a.answers.length === 0) return `"${q.question}" = Unanswered`;
    const note = a.note ? ` (note: ${a.note})` : "";
    if (a.wasCustom) return `"${q.question}" = User wrote: ${a.answers[0]}${note}`;
    if (a.customText) {
      const labels = a.answers.slice(0, -1).join(", ");
      return `"${q.question}" = ${labels}, user wrote: ${a.customText}${note}`;
    }
    return `"${q.question}" = ${a.answers.join(", ")}${note}`;
  });
  return (
    `User has answered your questions: ${parts.join(". ")}. ` +
    `You can now continue with the user's answers in mind.`
  );
}

/** Build a plain-text answer summary for the tool content. */
function buildTextOutput(
  questions: QuestionDef[],
  answers: QuestionAnswer[],
): string {
  return answers
    .map((a, i) => {
      const header = a.header || `Q${i + 1}`;
      if (a.answers.length === 0) return `${header}: Unanswered`;
      const note = a.note ? ` (note: ${a.note})` : "";
      if (a.wasCustom) return `${header}: User wrote: ${a.answers[0]}${note}`;
      if (a.customText) {
        const labels = a.answers.slice(0, -1).join(", ");
        return `${header}: ${labels}, user wrote: ${a.customText}${note}`;
      }
      return `${header}: ${a.answers.join(", ")}${note}`;
    })
    .join("\n");
}

/** Produce a flat answer-array matching OpenCode's output shape. */
function buildAnswerArrays(answers: QuestionAnswer[]): string[][] {
  return answers.map((a) => a.answers);
}

interface DialogUi {
  select(
    title: string,
    options: string[],
    opts?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  input(
    title: string,
    placeholder?: string,
    opts?: { signal?: AbortSignal },
  ): Promise<string | undefined>;
  confirm(
    title: string,
    message: string,
    opts?: { signal?: AbortSignal },
  ): Promise<boolean>;
}

/**
 * Sequential dialog fallback for RPC mode, where ctx.ui.custom() is not
 * available but select/input/confirm are served over the JSON protocol.
 */
async function askQuestionsViaDialogs(
  questions: QuestionDef[],
  ui: DialogUi,
  signal: AbortSignal | undefined,
): Promise<QuestionAnswer[] | null> {
  const CUSTOM = "✎ Type something…";
  const DONE = "✔ Done selecting";
  const answers: QuestionAnswer[] = [];
  const dialogOpts = signal ? { signal } : undefined;

  for (const q of questions) {
    if (signal?.aborted) return null;
    const labels = q.options.map((o) => o.label);
    const selected = new Set<number>();
    let customText = "";
    let note = "";

    if (q.multiple) {
      while (true) {
        const state = labels.map(
          (label, i) => `${selected.has(i) ? "☑" : "☐"} ${label}`,
        );
        const choice = await ui.select(
          `${q.question} (select all that apply)`,
          [...state, CUSTOM, DONE],
          dialogOpts,
        );
        if (choice === undefined) return null;
        if (choice === DONE) break;
        if (choice === CUSTOM) {
          const typed = await ui.input(
            q.question,
            "Type your own answer",
            dialogOpts,
          );
          if (typed === undefined) return null;
          customText = typed.trim();
          continue;
        }
        const index = state.indexOf(choice);
        if (index >= 0) {
          if (selected.has(index)) selected.delete(index);
          else selected.add(index);
        }
      }
    } else {
      const choice = await ui.select(q.question, [...labels, CUSTOM], dialogOpts);
      if (choice === undefined) return null;
      if (choice === CUSTOM) {
        const typed = await ui.input(
          q.question,
          "Type your own answer",
          dialogOpts,
        );
        if (typed === undefined) return null;
        customText = typed.trim();
      } else {
        const index = labels.indexOf(choice);
        if (index >= 0) selected.add(index);
        const addNote = await ui.confirm(
          "Add a note?",
          `Add a supplementary note to "${choice}"?`,
          dialogOpts,
        );
        if (addNote) {
          const typed = await ui.input(
            `Note for "${choice}"`,
            "",
            dialogOpts,
          );
          if (typed === undefined) return null;
          note = typed.trim();
        }
      }
    }

    const picked = Array.from(selected)
      .sort((a, b) => a - b)
      .map((i) => labels[i]);
    const merged = customText
      ? q.multiple && picked.length > 0
        ? [...picked, customText]
        : [customText]
      : picked;
    answers.push({
      question: q.question,
      header: q.header || `Q${answers.length + 1}`,
      options: labels,
      answers: merged,
      wasCustom: customText !== "" && picked.length === 0,
      customText: picked.length > 0 && customText ? customText : undefined,
      note: note || undefined,
    });
  }
  return answers;
}

const editorThemeFor = (theme: { fg: (name: string, text: string) => string }): EditorTheme => ({
  borderColor: (s) => theme.fg("accent", s),
  selectList: {
    selectedPrefix: (t) => theme.fg("accent", t),
    selectedText: (t) => theme.fg("accent", t),
    description: (t) => theme.fg("muted", t),
    scrollInfo: (t) => theme.fg("dim", t),
    noMatch: (t) => theme.fg("warning", t),
  },
});

// ─── Extension ───────────────────────────────────────────────────────────────

export default function questionExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "question",
    label: "Question",
    description: [
      "Use this tool when you need to ask the user questions during execution. This allows you to:",
      "1. Gather user preferences or requirements",
      "2. Clarify ambiguous instructions",
      "3. Get decisions on implementation choices as you work",
      "4. Offer choices to the user about what direction to take.",
      "",
      "Usage notes:",
      '- A "Type something." option for a custom typed answer is added automatically; don\'t include "Other" or catch-all options',
      "- Answers are returned as arrays of labels; set `multiple: true` to allow selecting more than one",
      '- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
    ].join("\n"),
    promptSnippet:
      "Ask the user to choose between concrete options or type a custom answer",
    promptGuidelines: [
      "Use question when you need the user to choose between concrete options or provide a typed answer before continuing.",
      'When using question, put the recommended option first and add "(Recommended)" to its label.',
    ],
    parameters: InputSchema,
    prepareArguments(args: unknown) {
      if (!args || typeof args !== "object") return args as never;
      const input = args as {
        questions?: unknown;
        question?: unknown;
        options?: unknown;
      };
      if (Array.isArray(input.questions)) return args as never;
      if (typeof input.question === "string") {
        const options = Array.isArray(input.options)
          ? input.options.map((option) =>
              typeof option === "string" ? { label: option } : option,
            )
          : [];
        return {
          questions: [{ question: input.question, options }],
        } as never;
      }
      return args as never;
    },
    executionMode: "sequential",

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (params.questions.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "Error: No questions provided" },
          ],
          details: {
            questions: [],
            answers: [],
            cancelled: false,
          } as ToolOutput,
          isError: true,
        };
      }

      // ── Non-interactive fallback ──────────────────────────────────
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        const lines = params.questions.map((q) => {
          const opts = q.options
            .map((o, i) => `  ${i + 1}. ${o.label}`)
            .join("\n");
          return `Q: ${q.question}\nOptions:\n${opts}`;
        });
        return {
          content: [
            {
              type: "text" as const,
              text: `Cannot ask questions in non-interactive mode. Questions:\n\n${lines.join("\n\n")}`,
            },
          ],
          details: {
            questions: params.questions,
            answers: [],
            cancelled: true,
          } as ToolOutput,
        };
      }

      // ── Normalize ─────────────────────────────────────────────────
      const questions: QuestionDef[] = params.questions.map((q, i) => ({
        question: q.question,
        header: q.header || `Q${i + 1}`,
        options: q.options.map((o) => ({
          label: o.label,
          description: o.description,
          preview: o.preview,
        })),
        multiple: q.multiple ?? false,
      }));

      const isMulti = questions.length > 1;
      const hasSubmitTab = isMulti || questions[0]?.multiple === true;
      const totalTabs = hasSubmitTab ? questions.length + 1 : questions.length;

      // ── RPC mode: sequential dialogs (custom() is unavailable) ────
      if (ctx.mode === "rpc") {
        const rpcAnswers = await askQuestionsViaDialogs(
          questions,
          ctx.ui,
          signal,
        );
        if (!rpcAnswers) {
          return {
            content: [
              {
                type: "text" as const,
                text: "User cancelled the question.",
              },
            ],
            details: {
              questions,
              answers: [],
              cancelled: true,
            } as ToolOutput,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: buildLLMOutput(questions, rpcAnswers),
            },
          ],
          details: {
            questions,
            answers: rpcAnswers,
            cancelled: false,
            answerArrays: buildAnswerArrays(rpcAnswers),
            textSummary: buildTextOutput(questions, rpcAnswers),
          },
        };
      }

      // ── TUI mode: interactive component ───────────────────────────
      let finishDialog: ((cancelled: boolean) => void) | undefined;
      let dialogClosed = false;
      const onAbort = () => {
        if (!dialogClosed) finishDialog?.(true);
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      let result: ToolOutput | null;
      try {
        result = signal?.aborted
          ? null
          : await ctx.ui.custom<ToolOutput | null>(
        (tui, theme, _kb, done) => {
          // ── State ─────────────────────────────────────────────────
          let currentTab = 0;
          let optionIndex = 0;
          const selections: Set<number>[] = questions.map(() => new Set());
          const customAnswers: string[] = questions.map(() => "");
          const notes: string[] = questions.map(() => "");
          let editing:
            | { question: number; kind: "custom" | "note"; optionIndex?: number }
            | null = null;
          let cachedLines: string[] | undefined;
          let cachedWidth: number | undefined;
          let previewMd: Markdown | null = null;
          let lastPreviewIdx: number = -1;

          const editor = new Editor(tui, editorThemeFor(theme));

          const finish = (value: ToolOutput) => {
            dialogClosed = true;
            done(value);
          };
          finishDialog = (cancelled) => finish(buildResult(cancelled));

          // ── Helpers ───────────────────────────────────────────────

          function refresh() {
            cachedLines = undefined;
            tui.requestRender();
          }

          function isEditingFor(qIdx: number): boolean {
            return editing?.question === qIdx;
          }

          function openCustomEditor(qIdx: number) {
            editing = { question: qIdx, kind: "custom" };
            editor.focused = true;
            editor.setText(customAnswers[qIdx] ?? "");
            refresh();
          }

          function openNoteEditor(qIdx: number, optIdx: number) {
            editing = { question: qIdx, kind: "note", optionIndex: optIdx };
            editor.focused = true;
            editor.setText(notes[qIdx] ?? "");
            refresh();
          }

          function closeEditor() {
            editing = null;
            editor.focused = false;
            editor.setText("");
          }

          function currentQuestion(): QuestionDef | undefined {
            return questions[currentTab] ?? undefined;
          }

          function renderOptionsFor(qIdx: number): RenderOption[] {
            const q = questions[qIdx];
            if (!q) return [];
            const opts: RenderOption[] = q.options.map((o) => ({ ...o }));
            opts.push({ label: "Type something.", isOther: true });
            return opts;
          }

          function allAnswered(): boolean {
            return questions.every((_q, i) => {
              if (customAnswers[i]) return true;
              return selections[i].size > 0;
            });
          }

          function buildResult(cancelled: boolean): ToolOutput {
            const answers: QuestionAnswer[] = questions.map((q, i) => {
              const allOptions = q.options.map((o) => o.label);
              const sel = Array.from(selections[i])
                .filter((idx) => idx < q.options.length)
                .map((idx) => q.options[idx].label);
              const custom = customAnswers[i];
              if (custom) {
                const merged = q.multiple ? [...sel, custom] : [custom];
                return {
                  question: q.question,
                  header: q.header || `Q${i + 1}`,
                  options: allOptions,
                  answers: merged,
                  wasCustom: sel.length === 0,
                  customText: sel.length > 0 ? custom : undefined,
                };
              }
              return {
                question: q.question,
                header: q.header || `Q${i + 1}`,
                options: allOptions,
                answers: sel,
                wasCustom: false,
                note: notes[i] || undefined,
              };
            });
            return { questions, answers, cancelled };
          }

          // Navigate to a tab and reset option index.
          function goToTab(tab: number) {
            currentTab = tab;
            optionIndex = 0;
            if (editing) {
              closeEditor();
            }
            refresh();
          }

          // Mark the current question as answered (single-select path).
          function answerCurrent(label: string, isCustom: boolean) {
            if (isCustom) {
              customAnswers[currentTab] = label;
            } else {
              const opts = questions[currentTab].options;
              const idx = opts.findIndex((o) => o.label === label);
              selections[currentTab] = new Set(idx >= 0 ? [idx] : []);
              customAnswers[currentTab] = "";
              notes[currentTab] = "";
            }
          }

          // Advance to next unanswered question or submit tab.
          function advanceAfterAnswer() {
            if (!hasSubmitTab) {
              finish(buildResult(false));
              return;
            }

            // Move to next unanswered question or submit tab.
            if (isMulti) {
              for (let i = currentTab + 1; i < questions.length; i++) {
                if (!customAnswers[i] && selections[i].size === 0) {
                  goToTab(i);
                  return;
                }
              }
            }
            // All answered – go to submit tab.
            goToTab(questions.length);
          }

          // ── Editor submit ─────────────────────────────────────────
          editor.onSubmit = (value) => {
            if (!editing) return;
            const target = editing;
            const trimmed = value.trim();

            if (target.kind === "note") {
              notes[target.question] = trimmed;
              selections[target.question] = new Set([target.optionIndex ?? 0]);
              customAnswers[target.question] = "";
              closeEditor();
              advanceAfterAnswer();
              return;
            }

            if (!trimmed) {
              // Empty input clears an existing custom answer and stays put.
              customAnswers[target.question] = "";
              closeEditor();
              refresh();
              return;
            }

            const targetQuestion = questions[target.question];
            customAnswers[target.question] = trimmed;
            if (!targetQuestion.multiple) {
              selections[target.question] = new Set();
              notes[target.question] = "";
            }
            closeEditor();
            advanceAfterAnswer();
          };

          // ── Input handler ────────────────────────────────────────
          function handleInput(data: string) {
            // ── Editing a custom answer or a note ─────────────────
            if (editing) {
              if (matchesKey(data, Key.escape)) {
                closeEditor();
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            const q = currentQuestion();
            const opts = renderOptionsFor(currentTab);

            // ── Tab navigation (when a submit tab exists) ─────────
            if (hasSubmitTab) {
              if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
                goToTab((currentTab + 1) % totalTabs);
                return;
              }
              if (
                matchesKey(data, Key.shift("tab")) ||
                matchesKey(data, Key.left)
              ) {
                goToTab(
                  (currentTab - 1 + totalTabs) % totalTabs,
                );
                return;
              }
            }

            // ── Submit tab ────────────────────────────────────────
            if (currentTab === questions.length) {
              if (matchesKey(data, Key.enter)) {
                if (allAnswered()) {
                  finish(buildResult(false));
                }
                return;
              }
              if (matchesKey(data, Key.escape)) {
                finish(buildResult(true));
                return;
              }
              return;
            }

            // ── Option navigation ─────────────────────────────────
            if (!q) return;

            if (matchesKey(data, Key.up)) {
              optionIndex = Math.max(0, optionIndex - 1);
              refresh();
              return;
            }
            if (matchesKey(data, Key.down)) {
              optionIndex = Math.min(opts.length - 1, optionIndex + 1);
              refresh();
              return;
            }

            // ── Number keys: select/toggle option N ───────────────
            const digit = /^[1-9]$/.test(data) ? Number(data) : 0;
            if (digit > 0) {
              const target = digit - 1;
              if (target >= opts.length) return;
              optionIndex = target;
              const digitOpt = opts[target];
              if (digitOpt.isOther) {
                openCustomEditor(currentTab);
                return;
              }
              if (q.multiple) {
                if (selections[currentTab].has(target)) {
                  selections[currentTab].delete(target);
                } else {
                  selections[currentTab].add(target);
                }
                refresh();
                return;
              }
              answerCurrent(digitOpt.label, false);
              advanceAfterAnswer();
              return;
            }

            // ── Vim keys ──────────────────────────────────────────
            if (matchesKey(data, "j")) {
              optionIndex = Math.min(opts.length - 1, optionIndex + 1);
              refresh();
              return;
            }
            if (matchesKey(data, "k")) {
              optionIndex = Math.max(0, optionIndex - 1);
              refresh();
              return;
            }
            if (hasSubmitTab && matchesKey(data, "l")) {
              goToTab((currentTab + 1) % totalTabs);
              return;
            }
            if (hasSubmitTab && matchesKey(data, "h")) {
              goToTab((currentTab - 1 + totalTabs) % totalTabs);
              return;
            }

            // ── `e`: note for a single-select option ──────────────
            if (matchesKey(data, "e")) {
              const opt = opts[optionIndex];
              if (opt.isOther) {
                openCustomEditor(currentTab);
                return;
              }
              if (!q.multiple) {
                openNoteEditor(currentTab, optionIndex);
              }
              return;
            }

            // ── Multi-select: space to toggle ─────────────────────
            if (q.multiple && matchesKey(data, Key.space)) {
              const opt = opts[optionIndex];
              if (opt.isOther) {
                openCustomEditor(currentTab);
                return;
              }
              if (selections[currentTab].has(optionIndex)) {
                selections[currentTab].delete(optionIndex);
              } else {
                selections[currentTab].add(optionIndex);
              }
              refresh();
              return;
            }

            // ── Enter / Return ────────────────────────────────────
            if (matchesKey(data, Key.enter)) {
              const opt = opts[optionIndex];

              // "Type something" – open editor
              if (opt.isOther) {
                openCustomEditor(currentTab);
                return;
              }

              if (q.multiple) {
                // Confirm multi-selection: advance
                advanceAfterAnswer();
              } else {
                // Single-select: pick and advance
                answerCurrent(opt.label, false);
                advanceAfterAnswer();
              }
              return;
            }

            // ── Escape: cancel ────────────────────────────────────
            if (matchesKey(data, Key.escape)) {
              finish(buildResult(true));
            }
          }

          // ── Renderer ─────────────────────────────────────────────
          function render(width: number): string[] {
            if (cachedLines && cachedWidth === width) return cachedLines;

            const lines: string[] = [];
            const rw = Math.max(1, width);

            function pushWrapped(
              target: string[],
              w: number,
              prefix: string,
              text: string,
            ) {
              const pw = visibleWidth(prefix);
              if (pw >= w) {
                target.push(...wrapTextWithAnsi(prefix + text, w));
                return;
              }
              const wrapped = wrapTextWithAnsi(text, w - pw);
              const cont = " ".repeat(pw);
              for (let i = 0; i < wrapped.length; i++) {
                target.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
              }
            }

            function wrap(text: string) {
              lines.push(...wrapTextWithAnsi(text, rw));
            }

            function wrapPrefixed(prefix: string, text: string) {
              pushWrapped(lines, rw, prefix, text);
            }

            lines.push(theme.fg("accent", "─".repeat(rw)));

            // ── Tab bar (when a submit tab exists) ───────────────
            if (hasSubmitTab) {
              const tabParts: string[] = [];
              for (let i = 0; i < questions.length; i++) {
                const isActive = i === currentTab;
                const hasAns = customAnswers[i] !== "" || selections[i].size > 0;
                const lbl = truncateToWidth(
                  questions[i].header || `Q${i + 1}`,
                  30,
                );
                const box = hasAns ? "●" : "○";
                const text = ` ${box} ${lbl} `;
                const colored = hasAns
                  ? theme.fg("success", text)
                  : theme.fg("muted", text);
                const styled = isActive
                  ? theme.bg("selectedBg", theme.fg("text", text))
                  : colored;
                tabParts.push(styled + " ");
              }
              const canSubmit = allAnswered();
              const isSubmit = currentTab === questions.length;
              const submitLbl = " ✓ Submit ";
              const submitStyled = isSubmit
                ? theme.bg("selectedBg", theme.fg("text", submitLbl))
                : theme.fg(canSubmit ? "success" : "dim", submitLbl);
              tabParts.push(submitStyled);
              wrapPrefixed(" ", tabParts.join(""));
              lines.push("");
            }

            // ── Submit tab content ────────────────────────────────
            if (currentTab === questions.length) {
              wrapPrefixed(" ", theme.fg("accent", theme.bold("Ready to submit")));
              lines.push("");
              for (let i = 0; i < questions.length; i++) {
                const q = questions[i];
                const label = q.header || `Q${i + 1}`;
                const ans = customAnswers[i];
                const sel = selections[i];

                let summary: string;
                if (ans) {
                  summary = `${theme.fg("muted", `${label}: `)}${theme.fg("accent", `(wrote) ${ans}`)}`;
                } else if (sel.size > 0) {
                  const labels = Array.from(sel)
                    .filter((idx) => idx < q.options.length)
                    .map((idx) => q.options[idx].label);
                  summary = `${theme.fg("muted", `${label}: `)}${theme.fg("accent", labels.join(", "))}`;
                } else {
                  summary = `${theme.fg("muted", `${label}: `)}${theme.fg("warning", "—")}`;
                }
                wrapPrefixed(" ", summary);
              }
              lines.push("");
              if (allAnswered()) {
                wrapPrefixed(" ", theme.fg("success", "Press Enter to submit"));
              } else {
                const missing = questions
                  .filter((_q, i) => !customAnswers[i] && selections[i].size === 0)
                  .map((_q, i) => _q.header || `Q${i + 1}`)
                  .join(", ");
                wrapPrefixed(
                  " ",
                  theme.fg("warning", `Unanswered: ${missing}`),
                );
              }
              lines.push("");
              wrapPrefixed(
                " ",
                theme.fg("dim", "Tab/← → navigate • Enter submit • Esc cancel"),
              );
              lines.push(theme.fg("accent", "─".repeat(rw)));
              cachedLines = lines;
              cachedWidth = width;
              return lines;
            }

            // ── Question content ──────────────────────────────────
            const q = currentQuestion();
            if (!q) {
              lines.push("");
              lines.push(theme.fg("accent", "─".repeat(rw)));
              cachedLines = lines;
              return lines;
            }

            const opts = renderOptionsFor(currentTab);
            const termRows = tui.terminal?.rows ?? 24;
            const maxVisibleOptions = Math.max(4, Math.min(15, termRows - 10));
            const winStart = Math.max(
              0,
              Math.min(
                optionIndex - Math.floor(maxVisibleOptions / 2),
                Math.max(0, opts.length - maxVisibleOptions),
              ),
            );
            const winEnd = Math.min(opts.length, winStart + maxVisibleOptions);

            // Question text
            const questionText = q.multiple
              ? `${q.question} (select all that apply)`
              : q.question;
            wrapPrefixed(" ", theme.fg("text", questionText));
            lines.push("");

            // ── Helper: render an option line into a target array ──
            function renderOpt(
              target: string[],
              w: number,
              i: number,
              opt: RenderOption,
            ) {
              const isSelected = i === optionIndex;
              const isOther = opt.isOther === true;
              const isChecked = selections[currentTab].has(i);

              let prefix: string;
              if (q.multiple) {
                const check = isChecked ? "☑" : "☐";
                prefix = isSelected
                  ? theme.fg("accent", `> ${check} `)
                  : `  ${check} `;
              } else if (isSelected && isChecked) {
                prefix = theme.fg("accent", "> ✓ ");
              } else if (isSelected) {
                prefix = theme.fg("accent", "> ");
              } else if (isChecked) {
                prefix = theme.fg("success", "✓ ");
              } else {
                prefix = "  ";
              }

              const num = `${i + 1}. `;
              const labelStr = `${num}${opt.label}`;
              const isEditingCustom =
                isOther &&
                editing?.kind === "custom" &&
                editing.question === currentTab;
              const finalLabel = isEditingCustom ? `${labelStr} ✎` : labelStr;
              const color = isSelected || isEditingCustom ? "accent" : "text";

              pushWrapped(target, w, prefix, theme.fg(color, finalLabel));

              if (opt.description) {
                pushWrapped(
                  target,
                  w,
                  "     ",
                  theme.fg("muted", opt.description),
                );
              }

              if (!q.multiple && isChecked && notes[currentTab]) {
                pushWrapped(
                  target,
                  w,
                  "     ",
                  theme.fg("muted", `✎ ${notes[currentTab]}`),
                );
              }

              if (isOther && customAnswers[currentTab]) {
                pushWrapped(
                  target,
                  w,
                  "     ",
                  theme.fg("muted", `✎ ${customAnswers[currentTab]}`),
                );
              }
            }

            // ── Check for preview ─────────────────────────────────
            const highlightedOpt = opts[optionIndex];
            const showPreview = !!(
              highlightedOpt?.preview &&
              !highlightedOpt?.isOther &&
              !isEditingFor(currentTab) &&
              rw > 60
            );

            if (showPreview) {
              // ── Side-by-side layout ──────────────────────────
              const sepWidth = 3; // " │ "
              const leftWidth = Math.max(20, Math.floor((rw - 2) * 0.55));
              const rightWidth = rw - 2 - leftWidth - sepWidth;

              // Build left column (options + help)
              const leftLines: string[] = [];
              if (winStart > 0) {
                leftLines.push(theme.fg("dim", `↑ ${winStart} more`));
              }
              for (let i = winStart; i < winEnd; i++) {
                renderOpt(leftLines, leftWidth, i, opts[i]);
              }
              if (winEnd < opts.length) {
                leftLines.push(
                  theme.fg("dim", `↓ ${opts.length - winEnd} more`),
                );
              }
              // Left help text
              leftLines.push("");
              const helpL = q.multiple
                ? (hasSubmitTab
                    ? "Tab/← → • ↑↓ • Space • Enter • Esc"
                    : "↑↓ • Space • Enter • Esc")
                : (hasSubmitTab
                    ? "Tab/← → • ↑↓ • Enter • e note • Esc"
                    : "↑↓ • Enter • e note • Esc");
              const helpPrefix = " ";
              pushWrapped(leftLines, leftWidth, helpPrefix, theme.fg("dim", helpL));

              // Build right column (preview via Markdown)
              const previewText = highlightedOpt.preview!;
              if (!previewMd || lastPreviewIdx !== optionIndex) {
                const mdTheme: MarkdownTheme = {
                  heading: (s) => theme.fg("mdHeading", theme.bold(s)),
                  link: (s) => theme.fg("mdLink", s),
                  linkUrl: (s) => theme.fg("mdLinkUrl", s),
                  code: (s) => theme.fg("mdCode", s),
                  codeBlock: (s) => theme.fg("mdCodeBlock", s),
                  codeBlockBorder: (s) => theme.fg("mdCodeBlockBorder", s),
                  quote: (s) => theme.fg("mdQuote", s),
                  quoteBorder: (s) => theme.fg("mdQuoteBorder", s),
                  hr: (s) => theme.fg("mdHr", s),
                  listBullet: (s) => theme.fg("mdListBullet", s),
                  bold: (s) => theme.bold(s),
                  italic: (s) => theme.italic(s),
                  strikethrough: (s) => theme.strikethrough(s),
                  underline: (s) => theme.underline(s),
                };
                previewMd = new Markdown(previewText, 1, 0, mdTheme, {
                  color: (s) => theme.fg("text", s),
                });
                lastPreviewIdx = optionIndex;
              } else {
                previewMd.setText(previewText);
              }
              const allRightLines = previewMd.render(rightWidth);
              const maxPreviewLines = Math.max(4, termRows - 12);
              const rightLines =
                allRightLines.length > maxPreviewLines
                  ? [
                      ...allRightLines.slice(0, maxPreviewLines),
                      theme.fg(
                        "dim",
                        `↓ ${allRightLines.length - maxPreviewLines} more`,
                      ),
                    ]
                  : allRightLines;

              // Interleave columns
              const maxLines = Math.max(leftLines.length, rightLines.length);
              const sep = theme.fg("border", "│");
              for (let i = 0; i < maxLines; i++) {
                const left = i < leftLines.length
                  ? truncateToWidth(leftLines[i], leftWidth, "", true)
                  : " ".repeat(leftWidth);
                const right = i < rightLines.length ? rightLines[i] : "";
                lines.push(` ${left} ${sep} ${right}`);
              }
            } else {
              // ── Normal (full-width) layout ───────────────────
              if (winStart > 0) {
                wrapPrefixed(" ", theme.fg("dim", `↑ ${winStart} more`));
              }
              for (let i = winStart; i < winEnd; i++) {
                renderOpt(lines, rw, i, opts[i]);
              }
              if (winEnd < opts.length) {
                wrapPrefixed(
                  " ",
                  theme.fg("dim", `↓ ${opts.length - winEnd} more`),
                );
              }

              // ── Editor for custom input or note ──────────────
              if (isEditingFor(currentTab)) {
                lines.push("");
                const editorLabel =
                  editing?.kind === "note"
                    ? `Note for "${opts[editing.optionIndex ?? 0]?.label ?? ""}":`
                    : "Your answer:";
                wrapPrefixed(" ", theme.fg("muted", editorLabel));
                for (const line of editor.render(Math.max(1, rw - 2))) {
                  lines.push(` ${line}`);
                }
                lines.push("");
                wrapPrefixed(
                  " ",
                  theme.fg(
                    "dim",
                    editing?.kind === "note"
                      ? "Enter to save • Esc to go back"
                      : "Enter to submit • Esc to go back",
                  ),
                );
              } else {
                lines.push("");
                // Help text
                if (q.multiple) {
                  const help = hasSubmitTab
                    ? "Tab/← → navigate • ↑↓ move • Space toggle • Enter confirm • Esc cancel"
                    : "↑↓ move • Space toggle • Enter confirm • Esc cancel";
                  wrapPrefixed(" ", theme.fg("dim", help));
                } else {
                  const help = hasSubmitTab
                    ? "Tab/← → navigate • ↑↓ select • Enter pick • e note • Esc cancel"
                    : "↑↓ select • Enter pick • e note • Esc cancel";
                  wrapPrefixed(" ", theme.fg("dim", help));
                }
              }
            }

            lines.push(theme.fg("accent", "─".repeat(rw)));
            cachedLines = lines;
            cachedWidth = width;
            return lines;
          }

          return {
            render,
            invalidate: () => {
              cachedLines = undefined;
              cachedWidth = undefined;
              previewMd?.invalidate();
            },
            handleInput,
          };
        },
            );
      } finally {
        signal?.removeEventListener("abort", onAbort);
      }

      // ── Handle cancellation ──────────────────────────────────────
      if (!result || result.cancelled) {
        return {
          content: [
            {
              type: "text" as const,
              text: "User cancelled the question.",
            },
          ],
          details: {
            questions,
            answers: [],
            cancelled: true,
          } as ToolOutput,
        };
      }

      // ── Build output ─────────────────────────────────────────────
      return {
        content: [
          {
            type: "text" as const,
            text: buildLLMOutput(questions, result.answers),
          },
        ],
        details: {
          questions,
          answers: result.answers,
          cancelled: false,
          answerArrays: buildAnswerArrays(result.answers),
          textSummary: buildTextOutput(questions, result.answers),
        },
      };
    },

    // ── TUI call rendering ──────────────────────────────────────────
    renderCall(args, theme, _context) {
      const qs = (args.questions as QuestionDef[]) || [];
      const count = qs.length;
      const preview = qs
        .map((q) => q.header || q.question.slice(0, 40))
        .join(", ");
      let text =
        theme.fg("toolTitle", theme.bold("question ")) +
        theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
      if (preview) {
        text += theme.fg("dim", ` (${preview})`);
      }
      return new Text(text, 0, 0);
    },

    // ── TUI result rendering ────────────────────────────────────────
    renderResult(result, options, theme, _context) {
      const textContent = (result.content ?? [])
        .filter(
          (part): part is { type: "text"; text: string } =>
            part.type === "text",
        )
        .map((part) => part.text)
        .join("\n");

      if (options.isError || !result.details) {
        return new Text(textContent, 0, 0);
      }

      const details = result.details as ToolOutput & {
        answerArrays?: string[][];
      };
      if (details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }

      const lines: string[] = [];
      for (const a of details.answers) {
        if (a.wasCustom) {
          lines.push(
            `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${theme.fg("muted", "(wrote)")} ${a.answers[0] || ""}`,
          );
          continue;
        }
        if (a.answers.length === 0) {
          lines.push(
            `${theme.fg("warning", "— ")}${theme.fg("muted", a.header)}`,
          );
          continue;
        }
        if (a.customText) {
          const labels = a.answers.slice(0, -1).join(", ");
          lines.push(
            `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${labels}, ${theme.fg("muted", "(wrote)")} ${a.customText}`,
          );
        } else {
          lines.push(
            `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${a.answers.join(", ")}`,
          );
        }
        if (a.note) {
          lines.push(`  ${theme.fg("dim", `✎ ${a.note}`)}`);
        }
      }
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
