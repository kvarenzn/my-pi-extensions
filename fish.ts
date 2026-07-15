/**
 * Fish Tool - Execute fish shell commands
 *
 * Wraps pi's built-in bash tool infrastructure with fish shell as the backend.
 * Uses createLocalBashOperations with shellPath set to /usr/bin/fish so that
 * all command execution, output streaming, truncation, and timeout handling
 * work identically to the built-in bash tool.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  // Create the same underlying tool definition as bash, but with fish as the
  // shell backend. This reuses all the execution, streaming, truncation,
  // timeout, and rendering logic from the built-in bash tool.
  const fishDef = createBashToolDefinition(cwd, {
    operations: createLocalBashOperations({ shellPath: "/usr/bin/fish" }),
  });

  pi.registerTool({
    ...fishDef,

    // Override name/label/description for fish
    name: "fish",
    label: "fish",
    description: [
      "Execute a fish shell command in the current working directory.",
      "Returns stdout and stderr.",
      "Output is truncated to last 2000 lines or 50KB (whichever is hit first).",
      "If truncated, full output is saved to a temp file.",
      "Optionally provide a timeout in seconds.",
    ].join(" "),
    promptSnippet: "Execute fish shell commands (ls, grep, find, etc.)",
  });
}
