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
    if (a.wasCustom) return `"${q.question}" = User wrote: ${a.answers[0]}`;
    return `"${q.question}" = ${a.answers.join(", ")}`;
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
      if (a.wasCustom) return `${header}: User wrote: ${a.answers[0]}`;
      return `${header}: ${a.answers.join(", ")}`;
    })
    .join("\n");
}

/** Produce a flat answer-array matching OpenCode's output shape. */
function buildAnswerArrays(answers: QuestionAnswer[]): string[][] {
  return answers.map((a) => a.answers);
}

const sharedTheme: EditorTheme = {
  borderColor: (s: string) => s,
  selectList: {
    selectedPrefix: (t: string) => t,
    selectedText: (t: string) => t,
    description: (t: string) => t,
    scrollInfo: (t: string) => t,
    noMatch: (t: string) => t,
  },
};

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
      '- A "Type your own answer" option is added automatically; don\'t include "Other" or catch-all options',
      "- Answers are returned as arrays of labels; set `multiple: true` to allow selecting more than one",
      '- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
    ].join("\n"),
    parameters: InputSchema,
    executionMode: "sequential",

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
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
      if (ctx.mode !== "tui") {
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
      const totalTabs = questions.length + 1; // question tabs + Submit tab

      const result = await ctx.ui.custom<ToolOutput | null>(
        (tui, theme, _kb, done) => {
          // ── State ─────────────────────────────────────────────────
          let currentTab = 0;
          let optionIndex = 0;
          const selections: Set<number>[] = questions.map(() => new Set());
          const customAnswers: string[] = questions.map(() => "");
          let editingQuestion: number = -1;
          let cachedLines: string[] | undefined;
          let previewMd: Markdown | null = null;
          let lastPreviewIdx: number = -1;

          const editor = new Editor(tui, sharedTheme);

          // ── Helpers ───────────────────────────────────────────────

          function refresh() {
            cachedLines = undefined;
            tui.requestRender();
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
              if (customAnswers[i]) {
                return {
                  question: q.question,
                  header: q.header || `Q${i + 1}`,
                  options: allOptions,
                  answers: [customAnswers[i]],
                  wasCustom: true,
                };
              }
              const sel = Array.from(selections[i])
                .filter((idx) => idx < q.options.length)
                .map((idx) => q.options[idx].label);
              return {
                question: q.question,
                header: q.header || `Q${i + 1}`,
                options: allOptions,
                answers: sel,
                wasCustom: false,
              };
            });
            return { questions, answers, cancelled };
          }

          // Navigate to a tab and reset option index.
          function goToTab(tab: number) {
            currentTab = tab;
            optionIndex = 0;
            if (editingQuestion >= 0) {
              editingQuestion = -1;
              editor.focused = false;
              editor.setText("");
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
            }
          }

          // Advance to next unanswered question or submit tab.
          function advanceAfterAnswer() {
            if (!isMulti) {
              done(buildResult(false));
              return;
            }

            // Move to next unanswered question or submit tab.
            for (let i = currentTab + 1; i < questions.length; i++) {
              if (!customAnswers[i] && selections[i].size === 0) {
                goToTab(i);
                return;
              }
            }
            // All answered – go to submit tab.
            goToTab(questions.length);
          }

          // ── Editor submit ─────────────────────────────────────────
          editor.onSubmit = (value) => {
            const trimmed = value.trim() || "(no response)";
            if (editingQuestion >= 0) {
              customAnswers[editingQuestion] = trimmed;
              selections[editingQuestion] = new Set();
              editingQuestion = -1;
              editor.focused = false;
              editor.setText("");

              if (!isMulti) {
                done(buildResult(false));
              } else {
                advanceAfterAnswer();
              }
            }
          };

          // ── Input handler ────────────────────────────────────────
          function handleInput(data: string) {
            // ── Editing a custom answer ───────────────────────────
            if (editingQuestion >= 0) {
              if (matchesKey(data, Key.escape)) {
                editingQuestion = -1;
                editor.focused = false;
                editor.setText("");
                refresh();
                return;
              }
              editor.handleInput(data);
              refresh();
              return;
            }

            const q = currentQuestion();
            const opts = renderOptionsFor(currentTab);

            // ── Tab navigation (multi-question only) ──────────────
            if (isMulti) {
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
                  done(buildResult(false));
                }
                return;
              }
              if (matchesKey(data, Key.escape)) {
                done(buildResult(true));
                return;
              }
              // Allow navigating back to a question by number.
              if (q && opts.length > 0) {
                // Fall through to option navigation for submit tab? No, submit tab has no options.
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

            // ── Multi-select: space to toggle ─────────────────────
            if (q.multiple && matchesKey(data, Key.space)) {
              const opt = opts[optionIndex];
              if (opt.isOther) {
                // "Type something" – go into edit mode (clears other selections)
                editingQuestion = currentTab;
                editor.focused = true;
                editor.setText("");
                refresh();
                return;
              }
              if (selections[currentTab].has(optionIndex)) {
                selections[currentTab].delete(optionIndex);
              } else {
                selections[currentTab].add(optionIndex);
              }
              customAnswers[currentTab] = "";
              refresh();
              return;
            }

            // ── Enter / Return ────────────────────────────────────
            if (matchesKey(data, Key.enter)) {
              const opt = opts[optionIndex];

              // "Type something" – open editor
              if (opt.isOther) {
                editingQuestion = currentTab;
                editor.focused = true;
                editor.setText("");
                refresh();
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
              done(buildResult(true));
            }
          }

          // ── Renderer ─────────────────────────────────────────────
          function render(width: number): string[] {
            if (cachedLines) return cachedLines;

            const lines: string[] = [];
            const rw = Math.max(1, width);

            function wrap(text: string) {
              lines.push(...wrapTextWithAnsi(text, rw));
            }

            function wrapPrefixed(prefix: string, text: string) {
              const pw = visibleWidth(prefix);
              if (pw >= rw) {
                wrap(prefix + text);
                return;
              }
              const wrapped = wrapTextWithAnsi(text, rw - pw);
              const cont = " ".repeat(pw);
              for (let i = 0; i < wrapped.length; i++) {
                lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
              }
            }

            lines.push(theme.fg("accent", "─".repeat(rw)));

            // ── Tab bar (multi-question) ─────────────────────────
            if (isMulti) {
              const tabParts: string[] = [];
              for (let i = 0; i < questions.length; i++) {
                const isActive = i === currentTab;
                const hasAns = customAnswers[i] !== "" || selections[i].size > 0;
                const lbl = questions[i].header || `Q${i + 1}`;
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

            // Question text
            wrapPrefixed(" ", theme.fg("text", q.question));
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
              } else {
                prefix = isSelected
                  ? theme.fg("accent", "> ")
                  : "  ";
              }

              const num = `${i + 1}. `;
              const labelStr = `${num}${opt.label}`;
              const finalLabel = isOther && editingQuestion === currentTab
                ? `${labelStr} ✎`
                : labelStr;
              const color =
                isSelected || (isOther && editingQuestion === currentTab)
                  ? "accent"
                  : "text";

              const pw = visibleWidth(prefix);
              const text = theme.fg(color, finalLabel);
              if (pw >= w) {
                target.push(...wrapTextWithAnsi(prefix + text, w));
              } else {
                const wrapped = wrapTextWithAnsi(text, w - pw);
                const cont = " ".repeat(pw);
                for (let j = 0; j < wrapped.length; j++) {
                  target.push(`${j === 0 ? prefix : cont}${wrapped[j]}`);
                }
              }

              if (opt.description) {
                const dp = "     ";
                const dw = visibleWidth(dp);
                const descText = theme.fg("muted", opt.description);
                if (dw >= w) {
                  target.push(...wrapTextWithAnsi(dp + descText, w));
                } else {
                  const wrapped = wrapTextWithAnsi(descText, w - dw);
                  const cont = " ".repeat(dw);
                  for (let j = 0; j < wrapped.length; j++) {
                    target.push(`${j === 0 ? dp : cont}${wrapped[j]}`);
                  }
                }
              }
            }

            // ── Check for preview ─────────────────────────────────
            const highlightedOpt = opts[optionIndex];
            const showPreview = !!(
              highlightedOpt?.preview &&
              !highlightedOpt?.isOther &&
              editingQuestion !== currentTab &&
              rw > 60
            );

            if (showPreview) {
              // ── Side-by-side layout ──────────────────────────
              const sepWidth = 3; // " │ "
              const leftWidth = Math.max(20, Math.floor((rw - 2) * 0.55));
              const rightWidth = rw - 2 - leftWidth - sepWidth;

              // Build left column (options + help)
              const leftLines: string[] = [];
              for (let i = 0; i < opts.length; i++) {
                renderOpt(leftLines, leftWidth, i, opts[i]);
              }
              // Left help text
              leftLines.push("");
              const helpL = q.multiple
                ? (isMulti
                    ? "Tab/← → • ↑↓ • Space • Enter • Esc"
                    : "↑↓ • Space • Enter • Esc")
                : (isMulti
                    ? "Tab/← → • ↑↓ • Enter • Esc"
                    : "↑↓ • Enter • Esc");
              const helpPrefix = " ";
              const hpw = visibleWidth(helpPrefix);
              const helpWrapped = wrapTextWithAnsi(theme.fg("dim", helpL), leftWidth - hpw);
              const hcont = " ".repeat(hpw);
              for (let j = 0; j < helpWrapped.length; j++) {
                leftLines.push(`${j === 0 ? helpPrefix : hcont}${helpWrapped[j]}`);
              }

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
              const rightLines = previewMd.render(rightWidth);

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
              for (let i = 0; i < opts.length; i++) {
                renderOpt(lines, rw, i, opts[i]);
              }

              // ── Editor for custom input ──────────────────────
              if (editingQuestion === currentTab) {
                lines.push("");
                wrapPrefixed(" ", theme.fg("muted", "Your answer:"));
                for (const line of editor.render(Math.max(1, rw - 2))) {
                  lines.push(` ${line}`);
                }
                lines.push("");
                wrapPrefixed(
                  " ",
                  theme.fg("dim", "Enter to submit • Esc to go back"),
                );
              } else {
                lines.push("");
                // Help text
                if (q.multiple) {
                  const help = isMulti
                    ? "Tab/← → navigate • ↑↓ move • Space toggle • Enter confirm • Esc cancel"
                    : "↑↓ move • Space toggle • Enter confirm • Esc cancel";
                  wrapPrefixed(" ", theme.fg("dim", help));
                } else {
                  const help = isMulti
                    ? "Tab/← → navigate • ↑↓ select • Enter pick • Esc cancel"
                    : "↑↓ select • Enter pick • Esc cancel";
                  wrapPrefixed(" ", theme.fg("dim", help));
                }
              }
            }

            lines.push(theme.fg("accent", "─".repeat(rw)));
            cachedLines = lines;
            return lines;
          }

          return {
            render,
            invalidate: () => {
              cachedLines = undefined;
            },
            handleInput,
          };
        },
      );

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
      const llmOutput = buildLLMOutput(questions, result.answers);
      const textOutput = buildTextOutput(questions, result.answers);

      return {
        content: [{ type: "text" as const, text: llmOutput }],
        details: {
          questions,
          answers: result.answers,
          cancelled: false,
          answerArrays: buildAnswerArrays(result.answers),
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
    renderResult(result, _options, theme, _context) {
      const details = result.details as
        | (ToolOutput & { answerArrays?: string[][] })
        | undefined;
      if (!details || details.cancelled) {
        return new Text(theme.fg("warning", "Cancelled"), 0, 0);
      }
      const lines = details.answers.map((a) => {
        if (a.wasCustom) {
          return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${theme.fg("muted", "(wrote)")} ${a.answers[0] || ""}`;
        }
        if (a.answers.length === 0) {
          return `${theme.fg("warning", "— ")}${theme.fg("muted", a.header)}`;
        }
        return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.header)}: ${a.answers.join(", ")}`;
      });
      return new Text(lines.join("\n"), 0, 0);
    },
  });
}
