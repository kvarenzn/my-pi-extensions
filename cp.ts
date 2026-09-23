/**
 * cp Tool - Copy files and directories
 *
 * A model-callable `cp` tool that mirrors unix `cp` semantics on top of Node's
 * `fs.cp`:
 *   - `cp src dest`      copies src to dest (dest is the new name)
 *   - `cp src dir`       copies src into an existing directory as dir/src
 *   - `cp a b c dir`     copies multiple sources into an existing directory
 *
 * Directories are copied recursively by default. Paths are resolved relative to
 * the session working directory, `~` is expanded, and file mutations are
 * serialized through pi's file mutation queue.
 */

import { existsSync } from "node:fs";
import { cp as fsCp, lstat, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
	defineTool,
	type ExtensionAPI,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const cpSchema = Type.Object({
	source: Type.Union([Type.String(), Type.Array(Type.String())], {
		description:
			"Source path or list of source paths to copy (relative to the working directory, or absolute).",
	}),
	destination: Type.String({
		description:
			"Destination path. If it is an existing directory, sources are copied into it; otherwise it is used as the target name.",
	}),
	overwrite: Type.Optional(
		Type.Boolean({
			description: "Overwrite existing files/directories. Default: true.",
		}),
	),
	recursive: Type.Optional(
		Type.Boolean({
			description: "Copy directories recursively. Default: true.",
		}),
	),
	dereference: Type.Optional(
		Type.Boolean({
			description: "Follow symbolic links and copy the linked content. Default: false.",
		}),
	),
	preserveTimestamps: Type.Optional(
		Type.Boolean({
			description: "Preserve source file timestamps (mtime/atime). Default: false.",
		}),
	),
});

interface CopiedItem {
	source: string;
	target: string;
}

interface CpDetails {
	sources: string[];
	destination: string;
	copied: CopiedItem[];
}

type PathType = "file" | "dir" | "symlink" | "other" | "missing";

/** Expand `~`, strip a leading `@`, and resolve relative to `cwd`. */
function expandPath(input: string, cwd: string): string {
	let p = input.trim();
	if (p.startsWith("@")) p = p.slice(1);
	if (p === "~") p = homedir();
	else if (p.startsWith("~/")) p = join(homedir(), p.slice(2));
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

async function pathType(p: string): Promise<PathType> {
	try {
		const stats = await lstat(p);
		if (stats.isSymbolicLink()) return "symlink";
		if (stats.isDirectory()) return "dir";
		if (stats.isFile()) return "file";
		return "other";
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return "missing";
		throw error;
	}
}

async function isDirectory(p: string): Promise<boolean> {
	try {
		return (await stat(p)).isDirectory();
	} catch {
		return false;
	}
}

/** True when `child` is `parent` itself or lives inside `parent`. */
function isInside(parent: string, child: string): boolean {
	if (parent === child) return true;
	const prefix = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(prefix);
}

interface ResolvedPlan {
	sources: string[];
	sourcesDisplay: string[];
	destination: string;
	destinationDisplay: string;
	targets: string[];
}

export default function cpExtension(pi: ExtensionAPI) {
	const cpTool = defineTool({
		name: "cp",
		label: "cp",
		description: [
			"Copy files and directories.",
			"Accepts one source or a list of sources.",
			"If the destination is an existing directory, sources are copied into it (like unix cp).",
			"Directories are copied recursively by default.",
			"Existing files are overwritten unless overwrite is false.",
		].join(" "),
		promptSnippet: "Copy files and directories (cp)",
		promptGuidelines: [
			"Use cp to copy files or directories; it handles recursion and overwrites, unlike a raw bash cp.",
		],
		parameters: cpSchema,
		// File mutations should not run concurrently with each other or sibling mutating tools.
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cwd = ctx?.cwd ?? process.cwd();
			const overwrite = params.overwrite ?? true;
			const recursive = params.recursive ?? true;
			const dereference = params.dereference ?? false;
			const preserveTimestamps = params.preserveTimestamps ?? false;

			const rawSources = Array.isArray(params.source) ? params.source : [params.source];
			if (rawSources.length === 0) {
				throw new Error("cp requires at least one source path.");
			}

			const destinationDisplay = params.destination;
			const destination = expandPath(params.destination, cwd);

			// A trailing separator forces "copy into this directory" semantics,
			// matching the intent of `cp a b/`.
			const destinationLooksLikeDir =
				params.destination.endsWith("/") || params.destination.endsWith(sep);
			const destinationIsDir = (await isDirectory(destination)) || destinationLooksLikeDir;

			if (rawSources.length > 1 && !destinationIsDir) {
				throw new Error(
					`cp with multiple sources requires the destination to be a directory: ${destinationDisplay}`,
				);
			}

			// Validate sources before touching the filesystem.
			const sources: string[] = [];
			for (const raw of rawSources) {
				const source = expandPath(raw, cwd);
				const type = await pathType(source);
				if (type === "missing") {
					throw new Error(`Source does not exist: ${raw}`);
				}
				if (type === "dir" && !recursive) {
					throw new Error(
						`Source is a directory but recursive is false: ${raw}. Omit recursive (or set it to true) to copy directories.`,
					);
				}
				if (type === "other") {
					throw new Error(`Source is not a regular file or directory: ${raw}`);
				}
				sources.push(source);
			}

			const plan: ResolvedPlan = {
				sources,
				sourcesDisplay: rawSources,
				destination,
				destinationDisplay,
				targets: sources.map((source) =>
					destinationIsDir ? join(destination, basename(source)) : destination,
				),
			};

			// Guard against recursive self-copy (`cp -r dir dir/sub`) and no-op self-copy.
			for (let i = 0; i < plan.sources.length; i++) {
				const source = plan.sources[i]!;
				const target = plan.targets[i]!;
				if (source === target) {
					throw new Error(`Source and destination are the same path: ${plan.sourcesDisplay[i]}`);
				}
				if (isInside(source, target)) {
					throw new Error(
						`Refusing to copy a directory into itself: ${plan.sourcesDisplay[i]} -> ${target}`,
					);
				}
			}

			// Pre-flight overwrite checks so we fail before mutating anything.
			if (!overwrite) {
				for (const target of plan.targets) {
					if (existsSync(target)) {
						throw new Error(
							`Destination already exists and overwrite is false: ${target}`,
						);
					}
				}
			}

			const throwIfAborted = () => {
				if (signal?.aborted) throw new Error("Operation aborted");
			};

			const copied: CopiedItem[] = [];
			for (let i = 0; i < plan.sources.length; i++) {
				throwIfAborted();
				const source = plan.sources[i]!;
				const target = plan.targets[i]!;

				await mkdir(dirname(target), { recursive: true });
				throwIfAborted();

				await withFileMutationQueue(target, async () => {
					await fsCp(source, target, {
						recursive,
						force: overwrite,
						errorOnExist: !overwrite,
						dereference,
						preserveTimestamps,
					});
					throwIfAborted();
				});

				copied.push({ source, target });
			}

			const label = copied.length === 1 ? "item" : "items";
			const lines = [
				`Copied ${copied.length} ${label} to ${plan.destinationDisplay}:`,
				...copied.map(({ source, target }) => `  ${source} -> ${target}`),
			];

			return {
				content: [{ type: "text", text: lines.join("\n") }],
				details: {
					sources: plan.sources,
					destination: plan.destination,
					copied,
				} satisfies CpDetails,
			};
		},

		renderCall(args, theme) {
			const sources = Array.isArray(args.source) ? args.source : [args.source];
			let text = theme.fg("toolTitle", theme.bold("cp "));
			text += theme.fg("accent", sources.map((s) => `"${s}"`).join(" "));
			text += theme.fg("muted", " -> ");
			text += theme.fg("accent", `"${args.destination}"`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Copying..."), 0, 0);
			}
			const details = result.details as CpDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(theme.fg("success", first?.type === "text" ? first.text : "Copied"), 0, 0);
			}

			let text = theme.fg(
				"success",
				`Copied ${details.copied.length} ${details.copied.length === 1 ? "item" : "items"}`,
			);
			text += theme.fg("muted", ` -> ${details.destination}`);
			if (expanded) {
				for (const { source, target } of details.copied) {
					text += `\n${theme.fg("dim", `${source} -> ${target}`)}`;
				}
			}
			return new Text(text, 0, 0);
		},
	});

	pi.registerTool(cpTool);
}
