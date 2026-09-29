import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultResourceLoader, ExtensionRunner, getDocsPath, getExamplesPath, getReadmePath, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import documentation from "../index.ts";

const { buildSystemPrompt } = await import(new URL("./core/system-prompt.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
const handlers = new Map();
documentation({ on: (name, handler) => handlers.set(name, handler) });
const beforeStart = handlers.get("before_agent_start");
const baseOptions = {
	cwd: "/project",
	selectedTools: ["read", "bash"],
	appendSystemPrompt: "Keep my appended instructions.",
	contextFiles: [{ path: "/project/AGENTS.md", content: "Keep project instructions." }],
	sections: {},
};

test("removes built-in docs while preserving the rest of the structured prompt", () => {
	const options = structuredClone(baseOptions);
	const before = buildSystemPrompt(options);
	beforeStart({ systemPrompt: before, systemPromptOptions: options });
	const after = buildSystemPrompt(options);
	assert.match(before, /Pi documentation \(read only/);
	assert.doesNotMatch(after, /Pi documentation \(read only/);
	assert.equal(after.replace(/<docs>[\s\S]*?<\/docs>/, ""), before.replace(/<docs>[\s\S]*?<\/docs>/, ""));
});

test("preserves custom prompts, forced prompts, and explicit docs overrides", () => {
	for (const custom of [{ customPrompt: "My custom prompt" }, { forceSystemPrompt: "My forced prompt" }, { sections: { docs: "My docs guidance" } }]) {
		const options = { ...structuredClone(baseOptions), ...custom };
		const before = buildSystemPrompt(options);
		assert.equal(beforeStart({ systemPrompt: before, systemPromptOptions: options }), undefined);
		assert.equal(buildSystemPrompt(options), before);
	}
});

test("legacy removal keeps appended context and does nothing to unrecognized prompts", () => {
	const docsBlock = buildSystemPrompt(baseOptions).match(/<docs>\n([\s\S]*?)\n<\/docs>/)[1];
	const systemPrompt = `Prefix\n\n${docsBlock}\n\nAppendix\n- Keep this bullet.\n<project_context>Keep this.</project_context>`;
	const result = beforeStart({ systemPrompt, systemPromptOptions: {} });
	assert.equal(result.systemPrompt, "Prefix\n\nAppendix\n- Keep this bullet.\n<project_context>Keep this.</project_context>");
	assert.equal(beforeStart({ systemPrompt: "Unrecognized prompt", systemPromptOptions: {} }), undefined);
	assert.equal(beforeStart({ systemPrompt: result.systemPrompt, systemPromptOptions: {} }), undefined);
});

test("skill uses the hosting Pi's paths independently of PATH and cleans up on shutdown", () => {
	const handlers = new Map();
	documentation({ on: (name, handler) => handlers.set(name, handler) });
	const previousPath = process.env.PATH;
	const previousPackageDir = process.env.PI_PACKAGE_DIR;
	try {
		process.env.PATH = "/another-pi-installation/bin";
		delete process.env.PI_PACKAGE_DIR;
		const resource = handlers.get("resources_discover")();
		const skillPath = resource.skillPaths[0];
		const content = readFileSync(skillPath, "utf8");
		for (const path of [getReadmePath(), getDocsPath(), getExamplesPath()]) {
			assert(content.includes(path));
			assert(existsSync(path));
		}
		assert.deepEqual(handlers.get("resources_discover")(), resource);
		handlers.get("session_shutdown")();
		assert(!existsSync(skillPath));
		handlers.get("session_shutdown")();
	} finally {
		handlers.get("session_shutdown")();
		if (previousPath === undefined) delete process.env.PATH;
		else process.env.PATH = previousPath;
		if (previousPackageDir === undefined) delete process.env.PI_PACKAGE_DIR;
		else process.env.PI_PACKAGE_DIR = previousPackageDir;
	}
});

test("one Pi resource toggle disables both prompt removal and skill discovery", async () => {
	const root = mkdtempSync(join(tmpdir(), "pisuite-docs-"));
	const packageDir = fileURLToPath(new URL("../", import.meta.url));
	try {
		for (const enabled of [true, false]) {
			const settings = SettingsManager.inMemory({ packages: [{ source: packageDir, ...(enabled ? {} : { extensions: ["-index.ts"] }) }] });
			const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings });
			await loader.reload();
			const { extensions, runtime, errors } = loader.getExtensions();
			assert.deepEqual(errors, []);
			assert.equal(extensions.length, Number(enabled));
			const runner = new ExtensionRunner(extensions, runtime, root, SessionManager.inMemory(), {});
			runner.onError((error) => assert.fail(error.error));
			try {
				const resources = await runner.emitResourcesDiscover(root, "startup");
				loader.extendResources({
					skillPaths: resources.skillPaths.map(({ path }) => ({
						path,
						metadata: { source: packageDir, scope: "temporary", origin: "top-level", baseDir: packageDir },
					})),
				});
				const skills = loader.getSkills().skills;
				assert.equal(skills.filter((skill) => skill.name === "pi-documentation").length, Number(enabled));
				assert.deepEqual(loader.getSkills().diagnostics, []);
				const result = await runner.emitBeforeAgentStart("Hello", undefined, { ...structuredClone(baseOptions), skills });
				const prompt = buildSystemPrompt(result.systemPromptOptions);
				assert.equal(prompt.includes("Pi documentation (read only"), !enabled);
				assert.equal(prompt.includes(getDocsPath()), !enabled);
			} finally {
				await runner.emit({ type: "session_shutdown", reason: "quit" });
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
