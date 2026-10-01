import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDocsPath, getExamplesPath, getReadmePath, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const extensionDir = dirname(fileURLToPath(import.meta.url));

// Match the complete legacy block, stopping before appended or project instructions.
const legacyDocs = /\n\nPi documentation \(read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI\):\n(?:- [^\n]*\n)*- Always read pi \.md files completely and follow links to related docs \(e\.g\., tui\.md for TUI API details\)/;

export default function (pi: ExtensionAPI): void {
	let skillDir: string | undefined;
	pi.on("resources_discover", () => {
		if (!skillDir) {
			skillDir = mkdtempSync(join(tmpdir(), "pisuite-pi-documentation-"));
			const guidance = readFileSync(join(extensionDir, "templates/pi-documentation/SKILL.md"), "utf8");
			writeFileSync(join(skillDir, "SKILL.md"), `${guidance}\n## Documentation paths\n\n- Main documentation: ${getReadmePath()}\n- Additional docs: ${getDocsPath()}\n- Examples: ${getExamplesPath()}\n`);
		}
		return { skillPaths: [join(skillDir, "SKILL.md")] };
	});

	pi.on("session_shutdown", () => {
		if (skillDir) rmSync(skillDir, { recursive: true, force: true });
		skillDir = undefined;
	});

	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		if (options?.customPrompt || options?.forceSystemPrompt !== undefined) return;

		if (options?.sections) {
			if (options.sections.docs !== undefined) return;
			// Pi ignores empty section overrides. Whitespace replaces its docs guidance
			// while keeping the other structured prompt sections and cache behavior.
			options.sections.docs = " ";
			return;
		}

		const systemPrompt = event.systemPrompt.replace(legacyDocs, "");
		if (systemPrompt !== event.systemPrompt) return { systemPrompt };
	});
}
