import { AsyncLocalStorage } from "node:async_hooks";
import { Agent, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { convertToLlm, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Subagents, type Subagent, type SubagentInfo } from "./subagents.ts";

const SpawnParams = Type.Object({
	task: Type.String({ minLength: 1, description: "Complete instructions for a fresh subagent. State whether to edit files or return findings." }),
	model: Type.Optional(Type.String({ description: "Provider/model-id, or an unambiguous model ID. Defaults to the calling agent's model." })),
	thinking: Type.Optional(Type.Union([
		Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
		Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
	])),
	background: Type.Optional(Type.Boolean({ default: false, description: "Return a subagent ID immediately and deliver its result later. With sequential Pi tool execution, use true inside codemode or custom tools and return without waiting." })),
});
const StatusParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Subagent ID. Omit to list all subagents." })),
	wait: Type.Optional(Type.Boolean({ description: "Wait for this subagent to finish. Requires an ID. With sequential Pi tool execution, call directly; inside codemode or custom tools poll without waiting." })),
});
const StopParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Stop this subagent and its descendants. Omit to stop all subagents." })),
});

type Model = NonNullable<ExtensionContext["model"]>;
interface Caller {
	ctx: ExtensionToolContext;
	model: Model;
	thinking: ThinkingLevel;
	parentId?: string;
	deferWait?: boolean;
	waitFor?: Subagent;
	spawnResult?: boolean;
}

function result(info: SubagentInfo | SubagentInfo[]) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
		details: info,
	};
}

async function waitForSubagent(subagent: Subagent, signal?: AbortSignal): Promise<void> {
	if (!signal) return subagent.done;
	signal.throwIfAborted();
	let abort: () => void;
	try {
		await Promise.race([subagent.done, new Promise<never>((_resolve, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
		})]);
	} finally {
		signal.removeEventListener("abort", abort!);
	}
}

function resolveModel(ctx: ExtensionContext, name?: string, inherited = ctx.model): Model {
	if (!name) {
		if (!inherited) throw new Error("Select a model before spawning a subagent.");
		return inherited;
	}
	const models = ctx.modelRegistry.getAll();
	const exact = models.find((model) => `${model.provider}/${model.id}` === name);
	if (exact) return exact;
	const matches = models.filter((model) => model.id === name);
	if (matches.length !== 1) throw new Error(`Unknown or ambiguous model: ${name}. Use provider/model-id.`);
	return matches[0];
}

export default function (pi: ExtensionAPI): void {
	const callerScope = new AsyncLocalStorage<Caller>();
	let uiContext: ExtensionContext | undefined;
	let unsubscribeInput: (() => void) | undefined;
	let unsubscribeAbort: (() => void) | undefined;
	let live = true;

	const updateStatus = () => {
		if (live) uiContext?.ui.setStatus("pisuite-subagents", subagents.activeCount ? `Subagents: ${subagents.activeCount}/${subagents.limit}` : undefined);
	};
	const subagents = new Subagents(updateStatus, (subagent) => {
		if (!live) return;
		callerScope.exit(() => pi.sendMessage({
			customType: "pisuite-subagents-result",
			content: `Background subagent result:\n${subagentResult(subagent).content[0].text}`,
			display: true,
			details: subagents.info(subagent),
		}, { deliverAs: "followUp", triggerTurn: true }));
	});

	function subagentResult(subagent: Subagent, reportUsage = false) {
		const info = subagents.info(subagent);
		if (info.output.length > 50_000) info.output = `${info.output.slice(0, 50_000)}\n[Truncated. Use subagent_status to retrieve the complete result.]`;
		return { ...result(info), isError: subagent.status === "failed" || subagent.status === "cancelled", usage: reportUsage ? takeUsage() : undefined };
	}

	function takeUsage() {
		// Nested subagent calls share the same ledger. Only main-agent calls
		// report it to Pi, so descendant model usage is counted once.
		return callerScope.getStore() ? undefined : subagents.takeUsage();
	}

	async function runSubagent(subagent: Subagent, caller: Caller): Promise<string> {
		const { model, thinking } = caller;
		const scope: Caller = { ...caller, parentId: subagent.id };
		const tools: AgentTool[] = caller.ctx.tools.map((tool) => ({
			...tool,
			execute: (_id, params, signal, onUpdate) => callerScope.run({ ...scope, deferWait: tool.name === "spawn_subagent" || tool.name === "subagent_status" }, async () => {
				subagent.controller.signal.throwIfAborted();
				const outcome = await caller.ctx.executeTool(tool.name, params, { signal, onUpdate });
				const waiting = callerScope.getStore()?.waitFor;
				if (!outcome.isError && waiting) {
					// Release Pi's serial nested-tool queue before waiting, so the
					// target subagent can use that queue to finish its own tools.
					await waitForSubagent(waiting, signal);
					const final = await callerScope.run({ ...scope, spawnResult: tool.name === "spawn_subagent" }, () =>
						caller.ctx.executeTool("subagent_status", { id: waiting.id }, { signal, onUpdate }));
					return { ...final.result, isError: final.isError };
				}
				return { ...outcome.result, isError: outcome.isError };
			}),
		}));
		const agent = new Agent({
			initialState: {
				model, thinkingLevel: thinking, tools,
				systemPrompt: caller.ctx.getSystemPrompt(),
				messages: [],
			},
			convertToLlm,
			streamFn: (selected, context, options) => caller.ctx.modelRegistry.streamSimple(selected, context, options),
		});
		const abort = () => agent.abort();
		subagent.controller.signal.addEventListener("abort", abort, { once: true });
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "tool_execution_start") subagents.update(subagent, `Using ${event.toolName}`);
			if (event.type === "message_end" && event.message.role === "assistant") {
				subagent.tokens += event.message.usage.totalTokens;
				subagent.cost += event.message.usage.cost.total;
				subagents.recordUsage(subagent, event.message.usage);
				subagents.update(subagent, "Thinking");
			}
		});
		try {
			subagent.controller.signal.throwIfAborted();
			await agent.prompt(`Subagent ID: ${subagent.id}\n\nTask:\n${subagent.task}`);
			subagent.controller.signal.throwIfAborted();
			const last = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
			if (!last || last.role !== "assistant") throw new Error("Subagent finished without an assistant response.");
			if (last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last.errorMessage || `Subagent ${last.stopReason}.`);
			return last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "(No text output.)";
		} finally {
			unsubscribe();
			subagent.controller.signal.removeEventListener("abort", abort);
			agent.clearAllQueues();
		}
	}

	const spawn: ToolDefinition<typeof SpawnParams> = {
		name: "spawn_subagent",
		label: "Spawn subagent",
		description: "Delegate a task to a subagent with fresh context and shared project/tool access. Subagents and descendants share four slots. Assign non-overlapping edit scopes.",
		parameters: SpawnParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!live) throw new Error("This subagent session has closed.");
			signal?.throwIfAborted();
			const parent = callerScope.getStore();
			const model = resolveModel(ctx, params.model, parent?.model ?? ctx.model);
			const thinking = params.thinking ?? parent?.thinking ?? ctx.thinkingLevel ?? "off";
			const caller: Caller = { ctx, model, thinking, parentId: parent?.parentId };
			const subagent = subagents.start({
				task: params.task, model: `${model.provider}/${model.id}`,
				background: params.background ?? false, parentId: caller.parentId,
			}, (record) => runSubagent(record, caller));
			if (subagent.background) return subagentResult(subagent);
			if (signal) {
				const abort = () => subagents.stop(subagent.id);
				signal.addEventListener("abort", abort, { once: true });
				const cleanup = () => signal.removeEventListener("abort", abort);
				void subagent.done.then(cleanup, cleanup);
			}
			onUpdate?.(subagentResult(subagent));
			if (parent?.deferWait) {
				parent.waitFor = subagent;
				return subagentResult(subagent);
			}
			await waitForSubagent(subagent, signal);
			return subagentResult(subagent, true);
		},
	};
	const status: ToolDefinition<typeof StatusParams> = {
		name: "subagent_status",
		label: "Subagent status",
		description: "Inspect subagent status and complete results. A subagent cannot wait on itself or an ancestor.",
		parameters: StatusParams,
		async execute(_id, params, signal) {
			if (!params.id) {
				if (params.wait) throw new Error("An ID is required when waiting for a subagent.");
				return { ...result(subagents.list()), usage: takeUsage() };
			}
			const subagent = subagents.get(params.id);
			if (params.wait) {
				const caller = callerScope.getStore();
				let ancestor = caller?.parentId;
				while (ancestor) {
					if (ancestor === subagent.id) throw new Error("A subagent cannot wait on itself or an ancestor.");
					ancestor = subagents.get(ancestor).parentId;
				}
				if (caller?.deferWait) caller.waitFor = subagent;
				else await waitForSubagent(subagent, signal);
			}
			return callerScope.getStore()?.spawnResult
				? subagentResult(subagent)
				: { ...result(subagents.info(subagent)), usage: takeUsage() };
		},
	};
	const stop: ToolDefinition<typeof StopParams> = {
		name: "stop_subagent",
		label: "Stop subagent",
		description: "Cancel subagents and suppress their background completion messages.",
		parameters: StopParams,
		async execute(_id, params) {
			return { ...result(subagents.stop(params.id)), usage: takeUsage() };
		},
	};
	for (const tool of [spawn, status, stop]) {
		pi.registerTool(tool as ToolDefinition);
	}

	pi.on("session_start", (_event, ctx) => {
		uiContext = ctx;
		unsubscribeInput?.();
		if (ctx.mode === "tui") unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if ((matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) && subagents.activeCount) subagents.stop();
			return undefined;
		});
		updateStatus();
	});
	pi.on("agent_start", (_event, ctx) => {
		unsubscribeAbort?.();
		const signal = ctx.signal;
		const abort = () => subagents.stop();
		signal?.addEventListener("abort", abort, { once: true });
		unsubscribeAbort = () => signal?.removeEventListener("abort", abort);
		if (signal?.aborted) abort();
	});
	pi.on("session_shutdown", async () => {
		live = false;
		unsubscribeInput?.();
		unsubscribeAbort?.();
		await subagents.close();
		uiContext?.ui.setStatus("pisuite-subagents", undefined);
	});
	pi.registerCommand("subagents", {
		description: "List subagents, or stop them with /subagents stop [subagent-id]",
		handler: async (args, ctx) => {
			const [action, id] = args.trim().split(/\s+/);
			if (action === "stop") subagents.stop(id);
			else if (action) throw new Error("Usage: /subagents or /subagents stop [subagent-id]");
			const list = subagents.list();
			ctx.ui.notify(list.length ? list.map((subagent) => `${subagent.id}: ${subagent.status} (${subagent.model}) ${subagent.task.slice(0, 80)}`).join("\n") : "No subagents in this session.", "info");
		},
	});
}
