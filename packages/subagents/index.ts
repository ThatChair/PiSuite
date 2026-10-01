import { AsyncLocalStorage } from "node:async_hooks";
import { Agent, type AgentTool, type ThinkingLevel } from "@earendil-works/pi-agent-core";
import { convertToLlm, type ExtensionAPI, type ExtensionContext, type ExtensionToolContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Workers, type Worker, type WorkerInfo } from "./workers.ts";

const SpawnParams = Type.Object({
	task: Type.String({ minLength: 1, description: "Complete instructions for a fresh worker. State whether to edit files or return findings." }),
	model: Type.Optional(Type.String({ description: "Provider/model-id, or an unambiguous model ID. Defaults to the calling agent's model." })),
	thinking: Type.Optional(Type.Union([
		Type.Literal("off"), Type.Literal("minimal"), Type.Literal("low"), Type.Literal("medium"),
		Type.Literal("high"), Type.Literal("xhigh"), Type.Literal("max"),
	])),
	background: Type.Optional(Type.Boolean({ default: false, description: "Return a worker ID immediately and deliver its result later. With sequential Pi tool execution, use true inside codemode or custom tools and return without waiting." })),
});
const StatusParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Worker ID. Omit to list all workers." })),
	wait: Type.Optional(Type.Boolean({ description: "Wait for this worker to finish. Requires an ID. With sequential Pi tool execution, call directly; inside codemode or custom tools poll without waiting." })),
});
const StopParams = Type.Object({
	id: Type.Optional(Type.String({ description: "Stop this worker and its descendants. Omit to stop all workers." })),
});

type Model = NonNullable<ExtensionContext["model"]>;
interface Caller {
	ctx: ExtensionToolContext;
	model: Model;
	thinking: ThinkingLevel;
	parentId?: string;
	deferWait?: boolean;
	waitFor?: Worker;
}

function result(info: WorkerInfo | WorkerInfo[]) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(info, null, 2) }],
		details: info,
	};
}

async function waitForWorker(worker: Worker, signal?: AbortSignal): Promise<void> {
	if (!signal) return worker.done;
	signal.throwIfAborted();
	let abort: () => void;
	try {
		await Promise.race([worker.done, new Promise<never>((_resolve, reject) => {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
		})]);
	} finally {
		signal.removeEventListener("abort", abort!);
	}
}

function resolveModel(ctx: ExtensionContext, name?: string, inherited = ctx.model): Model {
	if (!name) {
		if (!inherited) throw new Error("Select a model before spawning a worker.");
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
		if (live) uiContext?.ui.setStatus("pisuite-subagents", workers.activeCount ? `Workers: ${workers.activeCount}/${workers.limit}` : undefined);
	};
	const workers = new Workers(updateStatus, (worker) => {
		if (!live) return;
		pi.sendMessage({
			customType: "pisuite-subagents-result",
			content: `Background worker result:\n${workerResult(worker).content[0].text}`,
			display: true,
			details: workers.info(worker),
		}, { deliverAs: "followUp", triggerTurn: true });
	});

	function workerResult(worker: Worker) {
		const info = workers.info(worker);
		if (info.output.length > 50_000) info.output = `${info.output.slice(0, 50_000)}\n[Truncated. Use worker_status to retrieve the complete result.]`;
		return { ...result(info), isError: worker.status === "failed" || worker.status === "cancelled" };
	}

	async function runWorker(worker: Worker, caller: Caller): Promise<string> {
		const { model, thinking } = caller;
		const scope: Caller = { ...caller, parentId: worker.id };
		const tools: AgentTool[] = caller.ctx.tools.map((tool) => ({
			...tool,
			execute: (_id, params, signal, onUpdate) => callerScope.run({ ...scope, deferWait: tool.name === "spawn_worker" || tool.name === "worker_status" }, async () => {
				worker.controller.signal.throwIfAborted();
				const outcome = await caller.ctx.executeTool(tool.name, params, { signal, onUpdate });
				const waiting = callerScope.getStore()?.waitFor;
				if (!outcome.isError && waiting) {
					// Release Pi's serial nested-tool queue before waiting, so the
					// target worker can use that queue to finish its own tools.
					await waitForWorker(waiting, signal);
					return tool.name === "spawn_worker" ? workerResult(waiting) : result(workers.info(waiting));
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
		worker.controller.signal.addEventListener("abort", abort, { once: true });
		const unsubscribe = agent.subscribe((event) => {
			if (event.type === "tool_execution_start") workers.update(worker, `Using ${event.toolName}`);
			if (event.type === "message_end" && event.message.role === "assistant") {
				worker.tokens += event.message.usage.totalTokens;
				worker.cost += event.message.usage.cost.total;
				workers.update(worker, "Thinking");
			}
		});
		try {
			worker.controller.signal.throwIfAborted();
			await agent.prompt(`Worker ID: ${worker.id}\n\nTask:\n${worker.task}`);
			worker.controller.signal.throwIfAborted();
			const last = [...agent.state.messages].reverse().find((message) => message.role === "assistant");
			if (!last || last.role !== "assistant") throw new Error("Worker finished without an assistant response.");
			if (last.stopReason === "error" || last.stopReason === "aborted") throw new Error(last.errorMessage || `Worker ${last.stopReason}.`);
			return last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n") || "(No text output.)";
		} finally {
			unsubscribe();
			worker.controller.signal.removeEventListener("abort", abort);
			agent.clearAllQueues();
		}
	}

	const spawn: ToolDefinition<typeof SpawnParams> = {
		name: "spawn_worker",
		label: "Spawn worker",
		description: "Delegate a task to a worker with fresh context and shared project/tool access. Workers and descendants share four slots. Assign non-overlapping edit scopes.",
		parameters: SpawnParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			if (!live) throw new Error("This worker session has closed.");
			signal?.throwIfAborted();
			const parent = callerScope.getStore();
			const model = resolveModel(ctx, params.model, parent?.model ?? ctx.model);
			const thinking = params.thinking ?? parent?.thinking ?? ctx.thinkingLevel ?? "off";
			const caller: Caller = { ctx, model, thinking, parentId: parent?.parentId };
			const worker = workers.start({
				task: params.task, model: `${model.provider}/${model.id}`,
				background: params.background ?? false, parentId: caller.parentId,
			}, (record) => runWorker(record, caller));
			if (worker.background) return workerResult(worker);
			onUpdate?.(workerResult(worker));
			if (parent?.deferWait) {
				parent.waitFor = worker;
				return workerResult(worker);
			}
			await waitForWorker(worker, signal);
			return workerResult(worker);
		},
	};
	const status: ToolDefinition<typeof StatusParams> = {
		name: "worker_status",
		label: "Worker status",
		description: "Inspect worker status and complete results. A worker cannot wait on itself or an ancestor.",
		parameters: StatusParams,
		async execute(_id, params, signal) {
			if (!params.id) {
				if (params.wait) throw new Error("An ID is required when waiting for a worker.");
				return result(workers.list());
			}
			const worker = workers.get(params.id);
			if (params.wait) {
				const caller = callerScope.getStore();
				let ancestor = caller?.parentId;
				while (ancestor) {
					if (ancestor === worker.id) throw new Error("A worker cannot wait on itself or an ancestor.");
					ancestor = workers.get(ancestor).parentId;
				}
				if (caller?.deferWait) caller.waitFor = worker;
				else await waitForWorker(worker, signal);
			}
			return result(workers.info(worker));
		},
	};
	const stop: ToolDefinition<typeof StopParams> = {
		name: "stop_worker",
		label: "Stop worker",
		description: "Cancel workers and suppress their background completion messages.",
		parameters: StopParams,
		async execute(_id, params) {
			return result(workers.stop(params.id));
		},
	};
	for (const tool of [spawn, status, stop]) {
		pi.registerTool(tool as ToolDefinition);
	}

	pi.on("session_start", (_event, ctx) => {
		uiContext = ctx;
		unsubscribeInput?.();
		if (ctx.mode === "tui") unsubscribeInput = ctx.ui.onTerminalInput((data) => {
			if ((matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) && workers.activeCount) workers.stop();
			return undefined;
		});
		updateStatus();
	});
	pi.on("agent_start", (_event, ctx) => {
		unsubscribeAbort?.();
		const signal = ctx.signal;
		const abort = () => workers.stop();
		signal?.addEventListener("abort", abort, { once: true });
		unsubscribeAbort = () => signal?.removeEventListener("abort", abort);
		if (signal?.aborted) abort();
	});
	pi.on("session_shutdown", async () => {
		live = false;
		unsubscribeInput?.();
		unsubscribeAbort?.();
		await workers.close();
		uiContext?.ui.setStatus("pisuite-subagents", undefined);
	});
	pi.registerCommand("workers", {
		description: "List workers, or stop them with /workers stop [worker-id]",
		handler: async (args, ctx) => {
			const [action, id] = args.trim().split(/\s+/);
			if (action === "stop") workers.stop(id);
			else if (action) throw new Error("Usage: /workers or /workers stop [worker-id]");
			const list = workers.list();
			ctx.ui.notify(list.length ? list.map((worker) => `${worker.id}: ${worker.status} (${worker.model}) ${worker.task.slice(0, 80)}`).join("\n") : "No workers in this session.", "info");
		},
	});
}
