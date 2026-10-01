import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager } from "@earendil-works/pi-coding-agent";
import setup from "../index.ts";

function fixture(t, globalSettings = {}, projectSettings = {}) {
	const root = mkdtempSync(join(tmpdir(), "pisuite-setup-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(agentDir);
	mkdirSync(join(cwd, ".pi"), { recursive: true });
	const globalPath = join(agentDir, "settings.json");
	const projectPath = join(cwd, ".pi/settings.json");
	writeFileSync(globalPath, JSON.stringify(globalSettings));
	writeFileSync(projectPath, JSON.stringify(projectSettings));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	t.after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	});
	const installs = [];
	t.mock.method(DefaultPackageManager.prototype, "install", async (source) => { installs.push(source); });
	const handlers = new Map();
	const commands = new Map();
	setup({ on: (name, handler) => handlers.set(name, handler), registerCommand: (name, command) => commands.set(name, command) });
	const messages = [];
	const ctx = { cwd, ui: { notify: (message) => messages.push(message) } };
	return {
		installs, messages, ctx, handlers,
		run: () => commands.get("pisuite-setup").handler("", ctx),
		readGlobal: () => JSON.parse(readFileSync(globalPath, "utf8")),
		readProject: () => readFileSync(projectPath, "utf8"),
		globalPath,
		projectPath,
	};
}

test("startup reminds without installing; setup preserves choices; rerun does nothing", async (t) => {
	const original = { theme: "light", packages: ["npm:other-package@1.2.3"], skills: ["-skills/custom"] };
	const f = fixture(t, original);
	f.handlers.get("session_start")({}, f.ctx);
	assert.deepEqual(f.installs, []);
	assert.deepEqual(f.readGlobal(), original);
	assert.match(f.messages[0], /\/pisuite-setup/);
	await f.run();
	assert.deepEqual(f.installs, ["npm:pisuite-pi-documentation"]);
	assert.deepEqual(f.readGlobal(), { ...original, packages: [...original.packages, "npm:pisuite-pi-documentation"] });
	const after = readFileSync(f.globalPath, "utf8");
	await f.run();
	assert.equal(f.installs.length, 1);
	assert.equal(readFileSync(f.globalPath, "utf8"), after);
	assert.match(f.messages.at(-1), /already configured/);
});

test("preserves disabled pinned global packages without repairing missing installs", async (t) => {
	const original = { packages: [{ source: "npm:pisuite-pi-documentation@0.1.0", extensions: [], skills: [] }] };
	const f = fixture(t, original);
	await f.run();
	assert.deepEqual(f.installs, []);
	assert.deepEqual(f.readGlobal(), original);
});

test("preserves disabled pinned npm entries with whitespace", async (t) => {
	for (const source of ["npm: pisuite-pi-documentation@0.1.0", "npm:pisuite-pi-documentation@0.1.0 \t", " npm:pisuite-pi-documentation@0.1.0"]) {
		for (const scope of ["global", "project"]) {
			await t.test(`${scope}: ${JSON.stringify(source)}`, async (t) => {
				const original = { packages: [{ source, extensions: [] }] };
				const f = fixture(t, scope === "global" ? original : {}, scope === "project" ? original : {});
				const beforeGlobal = readFileSync(f.globalPath, "utf8");
				const beforeProject = f.readProject();
				f.handlers.get("session_start")({}, f.ctx);
				await f.run();
				assert.deepEqual(f.installs, []);
				assert.deepEqual(f.messages, ["PiSuite is already configured."]);
				assert.equal(readFileSync(f.globalPath, "utf8"), beforeGlobal);
				assert.equal(f.readProject(), beforeProject);
			});
		}
	}
});

test("disabled project entries and autoload deltas are left alone", async (t) => {
	const project = { packages: [{ source: "npm:pisuite-pi-documentation@next", autoload: false, extensions: ["-index.ts"] }] };
	const f = fixture(t, { theme: "dark" }, project);
	const before = f.readProject();
	await f.run();
	assert.deepEqual(f.installs, []);
	assert.equal(f.readProject(), before);
	assert.deepEqual(f.readGlobal(), { theme: "dark" });
});

test("recognizes standalone local installs", async (t) => {
	const packagePath = fileURLToPath(new URL("../../pi-documentation/", import.meta.url));
	const f = fixture(t, { packages: [{ source: packagePath, extensions: [] }] });
	await f.run();
	assert.deepEqual(f.installs, []);
});

test("global installation uses global npm choices rather than project overrides", async (t) => {
	const f = fixture(t, { npmCommand: ["npm"] }, { npmCommand: ["project-command"] });
	t.mock.method(DefaultPackageManager.prototype, "install", async function () {
		assert.deepEqual(this.settingsManager.getSettings().npmCommand, ["npm"]);
	});
	await f.run();
	assert.deepEqual(f.readGlobal().packages, ["npm:pisuite-pi-documentation"]);
});

test("failed installs do not persist a package entry", async (t) => {
	const f = fixture(t);
	t.mock.method(DefaultPackageManager.prototype, "install", async () => { throw new Error("Package not published"); });
	await assert.rejects(f.run(), /Package not published/);
	assert.deepEqual(f.readGlobal(), {});
});

test("malformed settings abort setup without overwriting the file", async (t) => {
	const f = fixture(t);
	writeFileSync(f.globalPath, "{broken");
	assert.doesNotThrow(() => f.handlers.get("session_start")({}, f.ctx));
	await assert.rejects(f.run());
	assert.deepEqual(f.installs, []);
	assert.deepEqual(f.messages, []);
	assert.equal(readFileSync(f.globalPath, "utf8"), "{broken");
});

test("invalid project settings suppress the startup reminder and abort setup", async (t) => {
	const f = fixture(t);
	writeFileSync(f.projectPath, "{broken");
	assert.doesNotThrow(() => f.handlers.get("session_start")({}, f.ctx));
	await assert.rejects(f.run());
	assert.deepEqual(f.installs, []);
	assert.deepEqual(f.messages, []);
	assert.equal(f.readProject(), "{broken");
	assert.deepEqual(f.readGlobal(), {});
});

test("malformed package entries suppress reminders and cannot trigger installs", async (t) => {
	for (const entry of [null, {}, { source: 123 }, " "]) {
		await t.test(JSON.stringify(entry), async (t) => {
			const original = { packages: [entry] };
			const f = fixture(t, original);
			assert.doesNotThrow(() => f.handlers.get("session_start")({}, f.ctx));
			await assert.rejects(f.run(), /expected a non-empty source/);
			assert.deepEqual(f.installs, []);
			assert.deepEqual(f.messages, []);
			assert.deepEqual(f.readGlobal(), original);
		});
	}
});

test("non-array package settings abort before installing or changing either file", async (t) => {
	for (const packages of ["npm:pisuite-pi-documentation", null]) {
		for (const scope of ["global", "project"]) {
			await t.test(`${scope}: ${JSON.stringify(packages)}`, async (t) => {
				const original = { packages };
				const f = fixture(t, scope === "global" ? original : {}, scope === "project" ? original : {});
				const beforeGlobal = readFileSync(f.globalPath, "utf8");
				const beforeProject = f.readProject();
				assert.doesNotThrow(() => f.handlers.get("session_start")({}, f.ctx));
				await assert.rejects(f.run(), /packages must be an array/);
				assert.deepEqual(f.installs, []);
				assert.deepEqual(f.messages, []);
				assert.equal(readFileSync(f.globalPath, "utf8"), beforeGlobal);
				assert.equal(f.readProject(), beforeProject);
			});
		}
	}
});

test("unreadable local manifests suppress reminders and abort setup", async (t) => {
	for (const failure of ["invalid JSON", "unreadable file"]) {
		await t.test(failure, async (t) => {
			const f = fixture(t);
			const packagePath = join(f.ctx.cwd, "local-package");
			mkdirSync(packagePath);
			const manifestPath = join(packagePath, "package.json");
			if (failure === "invalid JSON") writeFileSync(manifestPath, "{broken");
			else mkdirSync(manifestPath);
			const original = { packages: [{ source: packagePath, extensions: [] }] };
			writeFileSync(f.globalPath, JSON.stringify(original));
			assert.doesNotThrow(() => f.handlers.get("session_start")({}, f.ctx));
			await assert.rejects(f.run());
			assert.deepEqual(f.installs, []);
			assert.deepEqual(f.messages, []);
			assert.deepEqual(f.readGlobal(), original);
		});
	}
});

test("preserves spaces in local package paths", async (t) => {
	const f = fixture(t);
	const packagePath = join(f.ctx.cwd, "local package");
	mkdirSync(packagePath);
	writeFileSync(join(packagePath, "package.json"), JSON.stringify({ name: "pisuite-pi-documentation" }));
	const original = { packages: [{ source: packagePath, extensions: [] }] };
	writeFileSync(f.globalPath, JSON.stringify(original));
	await f.run();
	assert.deepEqual(f.installs, []);
	assert.deepEqual(f.readGlobal(), original);
});
