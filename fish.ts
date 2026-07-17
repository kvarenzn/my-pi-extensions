/**
 * Fish Tool - Execute fish shell commands
 *
 * Wraps pi's built-in bash tool infrastructure with fish shell as the backend.
 * Uses createLocalBashOperations with shellPath set to /usr/bin/fish so that
 * all command execution, output streaming, truncation, and timeout handling
 * work identically to the built-in bash tool.
 */

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "child_process";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createBashToolDefinition,
  createLocalBashOperations,
} from "@earendil-works/pi-coding-agent";

/**
 * Locate the fish executable, following the same pattern as pi's built-in bash
 * tool (dist/utils/shell.js getShellConfig).
 *
 * Resolution order:
 *  1. FISH_PATH environment variable
 *  2. Common install locations (/usr/bin/fish, /usr/local/bin/fish, …)
 *  3. which fish on PATH
 *  4. /etc/shells
 */
function findFishPath(): string {
  // 1. Environment variable override
  const envPath = process.env.FISH_PATH;
  if (envPath) {
    if (existsSync(envPath)) return envPath;
    throw new Error(`FISH_PATH set but not found: ${envPath}`);
  }

  // 2. Common locations (fast path)
  const commonPaths = [
    "/usr/bin/fish",
    "/usr/local/bin/fish",
    "/opt/homebrew/bin/fish",
    "/home/linuxbrew/.linuxbrew/bin/fish",
  ];
  for (const p of commonPaths) {
    if (existsSync(p)) return p;
  }

  // 3. which fish on PATH (same approach as bash's findBashOnPath)
  try {
    const result = spawnSync("which", ["fish"], {
      encoding: "utf-8",
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
      if (firstMatch) return firstMatch;
    }
  } catch {
    // Ignore errors
  }

  // 4. /etc/shells as supplementary source
  try {
    const content = readFileSync("/etc/shells", "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.endsWith("/fish") && existsSync(trimmed)) {
        return trimmed;
      }
    }
  } catch {
    // Ignore errors
  }

  // 5. Give up with a helpful message
  throw new Error(
    [
      "fish shell not found.",
      "Options:",
      "  1. Install fish: https://fishshell.com/",
      "  2. Set FISH_PATH environment variable to point to your fish binary",
      "",
      `Searched: ${commonPaths.join(", ")}, PATH via \`which fish\`, and /etc/shells`,
    ].join("\n")
  );
}

export default function (pi: ExtensionAPI) {
  // Find fish executable, following the same pattern as pi's built-in bash tool
  // (see dist/utils/shell.js: getShellConfig).
  // Resolution order:
  //   1. FISH_PATH environment variable
  //   2. Common install locations
  //   3. which fish on PATH
  //   4. /etc/shells
  const shellPath = findFishPath();

  const cwd = process.cwd();

  // Create the same underlying tool definition as bash, but with fish as the
  // shell backend. This reuses all the execution, streaming, truncation,
  // timeout, and rendering logic from the built-in bash tool.
  const fishDef = createBashToolDefinition(cwd, {
    operations: createLocalBashOperations({ shellPath }),
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
