import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import subagents from "../index.ts";

const model = {
	id: "model", name: "Test", provider: "test", api: "openai-completions", baseUrl: "https://test.invalid",
	reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1024,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function reply(selected, content, stopReason = content.some((part) => part.type === "toolCall") ? "toolUse" : "stop", usage = {
	input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}) {
	const stream = createAssistantMessageEventStream();
	const message = {
		role: "assistant", content, api: selected.api, provider: selected.provider, model: selected.id,
		usage,
		stopReason, timestamp: Date.now(),
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: message });
		if (stopReason === "aborted" || stopReason === "error") stream.push({ type: "error", reason: stopReason, error: message });
		else stream.push({ type: "done", reason: stopReason, message });
		stream.end(message);
	});
	return stream;
}
const text = (value) => [{ type: "text", text: value }];
const call = (name, args) => [{ type: "toolCall", id: crypto.randomUUID(), name, arguments: args }];
const parse = (result) => JSON.parse(result.content[0].text);
const userText = (context) => {
	const content = context.messages.find((message) => message.role === "user").content;
	return typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
};

function fixture(t, respond) {
	const definitions = new Map();
	const handlers = new Map();
	const notifications = [];
	const requests = [];
	let terminalInput;
	const pi = {
		registerTool: (tool) => definitions.set(tool.name, tool),
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: () => {},
		sendMessage: (message, options) => notifications.push({ message, options }),
	};
	subagents(pi);
	const registry = {
		getAll: () => [model, { ...model, id: "other" }],
		streamSimple: (selected, context, options) => {
			requests.push({ model: selected, messages: structuredClone(context.messages), options });
			return respond(selected, context, options);
		},
	};
	const ctx = {
		model, modelRegistry: registry, thinkingLevel: "medium", cwd: "/project", mode: "sdk", signal: undefined,
		getSystemPrompt: () => "Project instructions and enabled skill descriptions.",
		ui: { setStatus: () => {}, onTerminalInput: (handler) => { terminalInput = handler; return () => {}; } },
		tools: [...definitions.values()],
		executeTool: async (name, args, options) => ({ result: await definitions.get(name).execute("nested-call", args, options.signal, options.onUpdate, ctx), isError: false }),
	};
	const execute = (name, args, signal) => definitions.get(name).execute("parent-call", args, signal, undefined, ctx);
	handlers.get("session_start")({}, ctx);
	t.after(() => handlers.get("session_shutdown")({}, ctx));
	return { execute, ctx, handlers, notifications, requests, get terminalInput() { return terminalInput; } };
}

test("foreground is default, subagents start fresh, and model overrides are per call", async (t) => {
	const f = fixture(t, (selected) => reply(selected, text("Audit findings")));
	const first = parse(await f.execute("spawn_subagent", { task: "Audit" }));
	assert.equal(first.background, false);
	assert.equal(first.status, "completed");
	assert.equal(first.output, "Audit findings");
	assert.equal(f.requests[0].model.id, "model");
	assert.equal(f.requests[0].messages.filter((message) => message.role === "user").length, 1);
	assert.match(JSON.stringify(f.requests[0].messages[0]), /Project instructions/);
	const second = parse(await f.execute("spawn_subagent", { task: "Deslop", model: "test/other", thinking: "low" }));
	assert.equal(second.model, "test/other");
	assert.equal(f.requests[1].options.reasoning, "low");
	assert.deepEqual(f.notifications, []);
	await assert.rejects(f.execute("spawn_subagent", { task: "Audit", model: "missing" }), /Unknown or ambiguous/);
});

test("background returns immediately, delivers results, and requests an automatic follow-up", async (t) => {
	let finish;
	const f = fixture(t, (selected, _context, options) => {
		if (options.signal.aborted) return reply(selected, [], "aborted");
		const stream = createAssistantMessageEventStream();
		finish = () => {
			const ready = reply(selected, text("Background findings"));
			(async () => { for await (const event of ready) stream.push(event); stream.end(await ready.result()); })();
		};
		return stream;
	});
	const started = parse(await f.execute("spawn_subagent", { task: "Audit", background: true }));
	assert.equal(started.status, "running");
	assert.deepEqual(f.notifications, []);
	await setImmediate();
	finish();
	const completed = parse(await f.execute("subagent_status", { id: started.id, wait: true }));
	assert.equal(completed.output, "Background findings");
	assert.equal(f.notifications.length, 1);
	assert.deepEqual(f.notifications[0].options, { deliverAs: "followUp", triggerTurn: true });
});

test("subagents can spawn foreground children with fresh context and inherit their parent's selected model", async (t) => {
	const f = fixture(t, (selected, context) => {
		const task = userText(context);
		if (task.includes("Task:\nParent") && !context.messages.some((message) => message.role === "toolResult")) {
			return reply(selected, call("spawn_subagent", { task: "Child" }));
		}
		return reply(selected, text(task.includes("Task:\nChild") ? "Child result" : "Parent result"));
	});
	await f.execute("spawn_subagent", { task: "Parent", model: "test/other" });
	const list = parse(await f.execute("subagent_status", {}));
	assert.equal(list.length, 2);
	assert.equal(list[1].parentId, list[0].id);
	assert.equal(list[1].model, "test/other");
	assert.equal(list[1].output, "Child result");
	assert.equal(f.requests[1].messages.filter((message) => message.role === "user").length, 1);
});

test("foreground usage includes descendants once, and background usage waits for a main-agent tool call", async (t) => {
	const usage = {
		input: 3, output: 5, cacheRead: 2, cacheWrite: 4, cacheWrite1h: 4, reasoning: 2, totalTokens: 14,
		cost: { input: 0.003, output: 0.005, cacheRead: 0.002, cacheWrite: 0.004, total: 0.014 },
	};
	const f = fixture(t, (selected, context) => {
		if (userText(context).includes("Task:\nParent") && !context.messages.some((message) => message.role === "toolResult")) {
			return reply(selected, call("spawn_subagent", { task: "Child" }), "toolUse", usage);
		}
		return reply(selected, text("Finished"), "stop", usage);
	});
	const foreground = await f.execute("spawn_subagent", { task: "Parent" });
	assert.equal(foreground.usage.totalTokens, 42);
	assert.equal(foreground.usage.input, 9);
	assert.equal(foreground.usage.cacheWrite1h, 12);
	assert.equal(foreground.usage.reasoning, 6);
	assert.equal(foreground.usage.cost.total, 0.042);
	assert.equal((await f.execute("subagent_status", {})).usage, undefined);
	const background = parse(await f.execute("spawn_subagent", { task: "Background", background: true }));
	await setImmediate();
	assert.equal(f.notifications.length, 1);
	assert.equal(f.notifications[0].message.usage, undefined);
	const status = await f.execute("subagent_status", { id: background.id });
	assert.deepEqual(status.usage, usage);
	assert.equal((await f.execute("subagent_status", { id: background.id })).usage, undefined);
});

test("main cancellation and model stop cancel background work without late completion messages", async (t) => {
	const f = fixture(t, (selected, _context, options) => {
		const stream = createAssistantMessageEventStream();
		const abort = () => {
			const ready = reply(selected, [], "aborted");
			(async () => { for await (const event of ready) stream.push(event); stream.end(await ready.result()); })();
		};
		if (options.signal.aborted) abort();
		else options.signal.addEventListener("abort", abort, { once: true });
		return stream;
	});
	const root = new AbortController();
	f.ctx.signal = root.signal;
	f.handlers.get("agent_start")({}, f.ctx);
	const first = parse(await f.execute("spawn_subagent", { task: "Audit", background: true }));
	root.abort();
	assert.equal(parse(await f.execute("subagent_status", { id: first.id, wait: true })).status, "cancelled");
	const second = parse(await f.execute("spawn_subagent", { task: "Deslop", background: true }));
	await f.execute("stop_subagent", { id: second.id });
	assert.equal(parse(await f.execute("subagent_status", { id: second.id, wait: true })).status, "cancelled");
	assert.deepEqual(f.notifications, []);
});

test("cancellation releases sibling waits and allows shutdown to finish", { timeout: 5000 }, async (t) => {
	const pending = [];
	const f = fixture(t, (selected, _context, options) => {
		if (options.signal.aborted) return reply(selected, [], "aborted");
		const stream = createAssistantMessageEventStream();
		pending.push(async (id) => {
			const ready = reply(selected, call("subagent_status", { id, wait: true }));
			for await (const event of ready) stream.push(event);
			stream.end(await ready.result());
		});
		return stream;
	});
	const first = parse(await f.execute("spawn_subagent", { task: "First", background: true }));
	const second = parse(await f.execute("spawn_subagent", { task: "Second", background: true }));
	await setImmediate();
	await Promise.all([pending[0](second.id), pending[1](first.id)]);
	await setImmediate();
	assert(parse(await f.execute("subagent_status", {})).every((subagent) => subagent.activity === "Using subagent_status"));
	await f.execute("stop_subagent", {});
	await f.handlers.get("session_shutdown")({}, f.ctx);
	assert(parse(await f.execute("subagent_status", {})).every((subagent) => subagent.status === "cancelled"));
	assert.deepEqual(f.notifications, []);
});

test("terminal cancellation recognizes both legacy and Kitty keys while the main agent is idle", async (t) => {
	const f = fixture(t, (selected, _context, options) => {
		const stream = createAssistantMessageEventStream();
		const abort = async () => {
			const ready = reply(selected, [], "aborted");
			for await (const event of ready) stream.push(event);
			stream.end(await ready.result());
		};
		if (options.signal.aborted) void abort();
		else options.signal.addEventListener("abort", abort, { once: true });
		return stream;
	});
	f.ctx.mode = "tui";
	f.handlers.get("session_start")({}, f.ctx);
	for (const key of ["\u001b", "\u0003", "\u001b[27u", "\u001b[99;5u"]) {
		const started = parse(await f.execute("spawn_subagent", { task: "Wait", background: true }));
		f.terminalInput(key);
		assert.equal(parse(await f.execute("subagent_status", { id: started.id, wait: true })).status, "cancelled");
	}
	assert.deepEqual(f.notifications, []);
});

test("real Pi tools preserve file access and permission hooks inside a subagent", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pisuite-subagent-host-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "existing.txt"), "Existing project data");
	const seen = [];
	let modelCalls = 0;
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("test", {
		baseUrl: model.baseUrl, api: model.api, apiKey: "test",
		models: [{ ...model, provider: undefined }],
		streamSimple: (selected, context) => {
			modelCalls++;
			const task = userText(context);
			if (!task.includes("Subagent ID:")) {
				if (context.messages.some((message) => message.role === "toolResult")) return reply(selected, text("Main finished"));
				return reply(selected, call("spawn_subagent", { task: "Read existing.txt, then attempt a blocked write" }));
			}
			const results = context.messages.filter((message) => message.role === "toolResult");
			if (results.length === 0) return reply(selected, call("read", { path: "existing.txt" }));
			if (results.length === 1) return reply(selected, call("write", { path: "blocked.txt", content: "Blocked" }));
			if (results.length === 2) return reply(selected, call("spawn_subagent", { task: "Forbidden child" }));
			assert.match(JSON.stringify(results[0].content), /Existing project data/);
			assert.equal(results[1].isError, true);
			assert.equal(results[2].isError, true);
			return reply(selected, text("Read succeeded; write was blocked"));
		},
	});
	const settings = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager: settings, noExtensions: true,
		extensionFactories: [subagents, (pi) => {
			pi.on("tool_call", (event) => {
				seen.push(event.toolName);
				if (event.toolName === "write") return { block: true, reason: "Test permission gate" };
				if (event.toolName === "spawn_subagent" && seen.filter((name) => name === "spawn_subagent").length > 1) return { block: true, reason: "No child subagents" };
			});
		}],
	});
	await loader.reload();
	const { session } = await createAgentSession({ cwd: root, model: runtime.getModel("test", "model"), modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(root) });
	t.after(() => session.dispose());
	await session.bindExtensions({});
	session.agent.toolExecution = "sequential";
	await session.prompt("Run a subagent audit");
	assert(seen.includes("spawn_subagent"));
	assert(seen.includes("read"));
	assert(seen.includes("write"));
	assert.equal(seen.filter((name) => name === "spawn_subagent").length, 2);
	assert(!existsSync(join(root, "blocked.txt")));
	assert.match(JSON.stringify(session.messages), /Read succeeded; write was blocked/);
	assert.equal(session.getSessionStats().tokens.total, modelCalls * 2);
});

test("a real background subagent uses tools and foreground children after the main turn, then wakes it", { timeout: 5000 }, async (t) => {
	for (const composite of [false, true]) await t.test(composite ? "child called inside a custom tool" : "child called directly", async (t) => {
		const root = mkdtempSync(join(tmpdir(), "pisuite-subagent-background-"));
		t.after(() => rmSync(root, { recursive: true, force: true }));
		writeFileSync(join(root, "existing.txt"), "Background project data");
		let release;
		const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
		runtime.registerProvider("test", {
			baseUrl: model.baseUrl, api: model.api, apiKey: "test", models: [{ ...model, provider: undefined }],
			streamSimple: (selected, context) => {
				if (!userText(context).includes("Subagent ID:")) {
					if (JSON.stringify(context.messages).includes("Background subagent result:")) {
						return reply(selected, context.messages.filter((message) => message.role === "toolResult").length > 1
							? text("Main received background findings") : call("subagent_status", {}));
					}
					if (context.messages.some((message) => message.role === "toolResult")) return reply(selected, text("Main idle"));
					return reply(selected, call("spawn_subagent", { task: "Read existing.txt", background: true, ...(composite ? { model: "virtual/router" } : {}) }));
				}
				const results = context.messages.filter((message) => message.role === "toolResult");
				if (userText(context).includes("Task:\nNested child")) {
					return reply(selected, results.length ? text("Child read succeeded") : call("read", { path: "existing.txt" }));
				}
				if (results.length === 1) return reply(selected, composite ? call("compose", {}) : call("spawn_subagent", { task: "Nested child" }));
				if (results.length > 1) {
					assert.match(JSON.stringify(context.messages), /Background project data/);
					assert.match(JSON.stringify(results[1]), /Child read succeeded/);
					if (composite) assert.match(JSON.stringify(results[1]), /COMPOSITE SENTINEL/);
					return reply(selected, text("Background read succeeded"));
				}
				const stream = createAssistantMessageEventStream();
				release = async () => {
					const ready = reply(selected, call("read", { path: "existing.txt" }));
					for await (const event of ready) stream.push(event);
					stream.end(await ready.result());
				};
				return stream;
			},
		});
		runtime.registerVirtualModel({ provider: "virtual", id: "router", name: "Test router", route: () => ({ model: runtime.getModel("test", "model"), thinkingLevel: "off" }) });
		const settings = SettingsManager.inMemory();
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, extensionFactories: [subagents, (pi) => pi.registerTool({
			name: "compose", label: "Compose", description: "Compose a child result", parameters: Type.Object({}),
			async execute(_id, _args, signal, _onUpdate, ctx) {
				const outcome = await ctx.executeTool("spawn_subagent", { task: "Nested child" }, { signal });
				assert.equal(outcome.isError, false);
				const child = parse(outcome.result);
				assert.equal(child.status, "completed");
				if (composite) assert.equal(child.model, "virtual/router");
				return { content: text(`COMPOSITE SENTINEL: ${child.output}`), details: {} };
			},
		})] });
		await loader.reload();
		const { session } = await createAgentSession({ cwd: root, model: runtime.getModel("test", "model"), modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(root) });
		t.after(() => session.dispose());
		await session.bindExtensions({});
		session.agent.toolExecution = "sequential";
		await session.prompt("Start a background subagent");
		assert.equal(session.isIdle, true);
		const resumed = new Promise((resolve) => session.subscribe((event) => {
			if (event.type === "agent_end") resolve();
		}));
		await release();
		await resumed;
		assert.match(JSON.stringify(session.messages), /Background read succeeded/);
		assert.match(JSON.stringify(session.messages), /Main received background findings/);
		assert.equal(session.getSessionStats().tokens.total, 18);
	});
});

test("one package toggle disables every subagent tool and command", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "pisuite-subagent-toggle-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const packageDir = fileURLToPath(new URL("../", import.meta.url));
	for (const enabled of [true, false]) {
		const settings = SettingsManager.inMemory({ packages: [{ source: packageDir, ...(enabled ? {} : { extensions: ["-index.ts"] }) }] });
		const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings });
		await loader.reload();
		const { extensions, errors } = loader.getExtensions();
		assert.deepEqual(errors, []);
		assert.equal(extensions.length, Number(enabled));
		assert.equal(extensions.flatMap((extension) => [...extension.tools.keys()]).length, enabled ? 3 : 0);
		assert.equal(extensions.flatMap((extension) => [...extension.commands.keys()]).length, enabled ? 1 : 0);
	}
});

async function hostFixture(t, respond, extensions = []) {
	const root = mkdtempSync(join(tmpdir(), "pisuite-subagent-regression-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeFileSync(join(root, "existing.txt"), "Existing project data");
	const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
	runtime.registerProvider("test", {
		baseUrl: model.baseUrl, api: model.api, apiKey: "test",
		models: [{ ...model, provider: undefined }, { ...model, id: "other", provider: undefined }],
		streamSimple: respond,
	});
	const settings = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, extensionFactories: [subagents, ...extensions] });
	await loader.reload();
	const { session } = await createAgentSession({ cwd: root, model: runtime.getModel("test", "model"), modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(root) });
	t.after(async () => {
		await loader.getExtensions().extensions[0].tools.get("stop_subagent").definition.execute("cleanup", {}, undefined, undefined, undefined);
		await setImmediate();
		session.dispose();
	});
	await session.bindExtensions({});
	session.agent.toolExecution = "sequential";
	return session;
}

test("cancelling a foreground spawn's own signal stops its work", async (t) => {
	let streamSignal;
	const f = fixture(t, (selected, _context, options) => {
		streamSignal = options.signal;
		const stream = createAssistantMessageEventStream();
		const abort = async () => {
			const ready = reply(selected, [], "aborted");
			for await (const event of ready) stream.push(event);
			stream.end(await ready.result());
		};
		if (options.signal.aborted) void abort();
		else options.signal.addEventListener("abort", abort, { once: true });
		return stream;
	});
	const controller = new AbortController();
	const pending = f.execute("spawn_subagent", { task: "Work owned by a custom tool" }, controller.signal);
	await setImmediate();
	controller.abort(new Error("Custom tool timeout"));
	await assert.rejects(pending, /Custom tool timeout/);
	assert.equal(parse(await f.execute("subagent_status", {}))[0].status, "cancelled");
	assert.equal(streamSignal.aborted, true);
});

test("foreground children can wait for siblings and final results pass through status hooks", { timeout: 5000 }, async (t) => {
	let firstId;
	let release;
	let finishSecond;
	let childResult;
	let siblingResult;
	const secondFinished = new Promise((resolve) => { finishSecond = resolve; });
	const finalHooks = new Set();
	const session = await hostFixture(t, (selected, context) => {
		const task = userText(context);
		const results = context.messages.filter((message) => message.role === "toolResult");
		if (!task.includes("Subagent ID:")) {
			if (!results.length) return reply(selected, call("spawn_subagent", { task: "First", background: true }));
			if (results.length === 1) return reply(selected, call("spawn_subagent", { task: "Second", background: true }));
			return reply(selected, text("Main idle"));
		}
		if (task.includes("Task:\nFirst")) {
			firstId = task.match(/Subagent ID: (\S+)/)[1];
			if (results.length) return reply(selected, text("Private first result"));
			const stream = createAssistantMessageEventStream();
			release = async () => {
				const ready = reply(selected, call("read", { path: "existing.txt" }));
				for await (const event of ready) stream.push(event);
				stream.end(await ready.result());
			};
			return stream;
		}
		if (task.includes("Task:\nSecond")) {
			if (!results.length) return reply(selected, call("spawn_subagent", { task: "Waiting child" }));
			childResult = results[0];
			finishSecond();
			return reply(selected, text("Second completed"));
		}
		if (!results.length) return reply(selected, call("subagent_status", { id: firstId, wait: true }));
		siblingResult = results[0];
		return reply(selected, text("Private child result " + "x".repeat(50_001)));
	}, [(pi) => pi.on("tool_result", (event) => {
		if (event.toolName !== "subagent_status") return;
		const info = JSON.parse(event.content[0].text);
		if (info.status !== "completed") return;
		finalHooks.add(info.task);
		if (info.task === "Waiting child") assert.match(info.output, /\[Truncated\./);
		const redacted = { ...info, output: `Filtered ${info.task}` };
		return { content: text(JSON.stringify(redacted)), details: redacted };
	})]);
	await session.prompt("Start two background subagents");
	await setImmediate();
	await release();
	await secondFinished;
	assert.equal(parse(siblingResult).output, "Filtered First");
	assert.equal(parse(childResult).output, "Filtered Waiting child");
	assert(finalHooks.has("First"));
	assert(finalHooks.has("Waiting child"));
});

test("a failed deferred child still returns an error result", { timeout: 5000 }, async (t) => {
	let childResult;
	const session = await hostFixture(t, (selected, context) => {
		const task = userText(context);
		const results = context.messages.filter((message) => message.role === "toolResult");
		if (!task.includes("Subagent ID:")) return reply(selected, results.length ? text("Main completed") : call("spawn_subagent", { task: "Parent" }));
		if (task.includes("Task:\nFailing child")) return reply(selected, [], "error");
		if (!results.length) return reply(selected, call("spawn_subagent", { task: "Failing child" }));
		childResult = results[0];
		return reply(selected, text("Parent handled failure"));
	});
	await session.prompt("Run parent");
	assert.equal(childResult.isError, true);
	assert.equal(parse(childResult).status, "failed");
});

test("nested background completion gives the main follow-up its own caller and model", { timeout: 5000 }, async (t) => {
	let release;
	let finishMain;
	const mainFinished = new Promise((resolve) => { finishMain = resolve; });
	const session = await hostFixture(t, (selected, context) => {
		const task = userText(context);
		const results = context.messages.filter((message) => message.role === "toolResult");
		if (!task.includes("Subagent ID:")) {
			if (!results.length) return reply(selected, call("spawn_subagent", { task: "Parent", model: "test/other" }));
			if (JSON.stringify(context.messages).includes("Background subagent result:") && results.length === 1) return reply(selected, call("spawn_subagent", { task: "Fresh root" }));
			if (results.length === 2) finishMain();
			return reply(selected, text("Main idle"));
		}
		if (task.includes("Task:\nParent")) return reply(selected, results.length ? text("Parent completed") : call("spawn_subagent", { task: "Nested background child", background: true }));
		if (task.includes("Task:\nFresh root")) return reply(selected, text("Fresh root completed"));
		const stream = createAssistantMessageEventStream();
		release = async () => {
			const ready = reply(selected, text("Nested background child completed"));
			for await (const event of ready) stream.push(event);
			stream.end(await ready.result());
		};
		return stream;
	});
	await session.prompt("Run parent and return");
	assert.equal(session.isIdle, true);
	await release();
	await mainFinished;
	await session.waitForIdle();
	const fresh = session.messages.filter((message) => message.role === "toolResult").at(-1);
	assert.equal(fresh.isError, false);
	assert.equal(parse(fresh).parentId, undefined);
	assert.equal(parse(fresh).model, "test/model");
});

test("the host receives raw arguments for compatibility shims and still validates inputs", { timeout: 5000 }, async (t) => {
	const executions = [];
	let childResults;
	const session = await hostFixture(t, (selected, context) => {
		const results = context.messages.filter((message) => message.role === "toolResult");
		if (!userText(context).includes("Subagent ID:")) return reply(selected, results.length ? text("Main completed") : call("spawn_subagent", { task: "Use compatibility tools" }));
		if (!results.length) return reply(selected, call("compat", { value: "original" }));
		if (results.length === 1) return reply(selected, call("edit", { path: "existing.txt", oldText: "Existing project data", newText: "Updated project data" }));
		if (results.length === 2) return reply(selected, call("compat", { value: { invalid: true } }));
		if (results.length === 3) return reply(selected, call("read", { path: "existing.txt" }));
		childResults = results;
		return reply(selected, text("Child completed"));
	}, [(pi) => pi.registerTool({
		name: "compat", label: "Compat", description: "Normalize input", parameters: Type.Object({ value: Type.String() }),
		prepareArguments: (args) => {
			if (typeof args?.value === "string") args.value += "-prepared";
			return args;
		},
		async execute(_id, args) {
			executions.push(args);
			return { content: text(args.value), details: args };
		},
	})]);
	await session.prompt("Run a child");
	assert.deepEqual(executions, [{ value: "original-prepared" }]);
	assert.equal(childResults[0].content[0].text, "original-prepared");
	assert.equal(childResults[1].isError, false);
	assert.equal(childResults[2].isError, true);
	assert.match(JSON.stringify(childResults[3].content), /Updated project data/);
});
