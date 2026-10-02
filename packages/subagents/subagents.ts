import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";

type Usage = NonNullable<AgentToolResult<unknown>["usage"]>;

function addUsage(first: Usage | undefined, second: Usage): Usage {
	if (!first) return structuredClone(second);
	return {
		input: first.input + second.input,
		output: first.output + second.output,
		cacheRead: first.cacheRead + second.cacheRead,
		cacheWrite: first.cacheWrite + second.cacheWrite,
		...(first.cacheWrite1h !== undefined || second.cacheWrite1h !== undefined
			? { cacheWrite1h: (first.cacheWrite1h ?? 0) + (second.cacheWrite1h ?? 0) } : {}),
		...(first.reasoning !== undefined || second.reasoning !== undefined
			? { reasoning: (first.reasoning ?? 0) + (second.reasoning ?? 0) } : {}),
		totalTokens: first.totalTokens + second.totalTokens,
		cost: {
			input: first.cost.input + second.cost.input,
			output: first.cost.output + second.cost.output,
			cacheRead: first.cost.cacheRead + second.cost.cacheRead,
			cacheWrite: first.cost.cacheWrite + second.cost.cacheWrite,
			total: first.cost.total + second.cost.total,
		},
	};
}

export type SubagentStatus = "running" | "completed" | "failed" | "cancelled";

export interface SubagentInfo {
	id: string;
	parentId?: string;
	task: string;
	model: string;
	background: boolean;
	status: SubagentStatus;
	output: string;
	activity: string;
	startedAt: number;
	finishedAt?: number;
	tokens: number;
	cost: number;
}

export interface Subagent extends SubagentInfo {
	controller: AbortController;
	done: Promise<void>;
	settled: boolean;
	unreportedUsage?: Usage;
}

export class Subagents {
	private records = new Map<string, Subagent>();
	private closed = false;
	private onChange: () => void;
	private onComplete: (subagent: Subagent) => void;
	readonly limit: number;

	constructor(onChange: () => void, onComplete: (subagent: Subagent) => void, limit = 4) {
		this.onChange = onChange;
		this.onComplete = onComplete;
		this.limit = limit;
	}

	get activeCount(): number {
		return [...this.records.values()].filter((subagent) => !subagent.settled).length;
	}

	get(id: string): Subagent {
		const subagent = this.records.get(id);
		if (!subagent) throw new Error(`Unknown subagent: ${id}`);
		return subagent;
	}

	list(): SubagentInfo[] {
		return [...this.records.values()].map((subagent) => this.info(subagent));
	}

	info(subagent: Subagent): SubagentInfo {
		const { controller: _controller, done: _done, settled: _settled, unreportedUsage: _usage, ...info } = subagent;
		return info;
	}

	recordUsage(subagent: Subagent, usage: Usage): void {
		subagent.unreportedUsage = addUsage(subagent.unreportedUsage, usage);
	}

	takeUsage(): Usage | undefined {
		let usage: Usage | undefined;
		for (const subagent of this.records.values()) {
			if (subagent.unreportedUsage) usage = addUsage(usage, subagent.unreportedUsage);
			subagent.unreportedUsage = undefined;
		}
		return usage;
	}

	start(input: Pick<SubagentInfo, "task" | "model" | "background" | "parentId">, run: (subagent: Subagent) => Promise<string>): Subagent {
		if (this.closed) throw new Error("This subagent session has closed.");
		if (!input.task.trim()) throw new Error("A subagent task cannot be empty.");
		if (input.parentId && this.get(input.parentId).status !== "running") {
			throw new Error("A stopped or finished subagent cannot spawn children.");
		}
		// Reject rather than queue: waiting parents must not fill the pool and
		// leave their own children waiting forever for a slot.
		if (this.activeCount >= this.limit) {
			throw new Error(`All ${this.limit} subagent slots are occupied. Wait for a subagent to finish before spawning another.`);
		}
		const subagent: Subagent = {
			...input,
			id: `subagent-${randomUUID()}`,
			status: "running",
			output: "",
			activity: "Starting",
			startedAt: Date.now(),
			tokens: 0,
			cost: 0,
			controller: new AbortController(),
			done: Promise.resolve(),
			settled: false,
		};
		this.records.set(subagent.id, subagent);
		subagent.done = Promise.resolve().then(async () => {
			try {
				subagent.controller.signal.throwIfAborted();
				const output = await run(subagent);
				if (subagent.status === "running") {
					subagent.output = output;
					subagent.status = "completed";
				}
			} catch (error) {
				if (subagent.status !== "cancelled") {
					subagent.status = "failed";
					subagent.output = error instanceof Error ? error.message : String(error);
				}
			} finally {
				subagent.settled = true;
				subagent.finishedAt = Date.now();
				subagent.activity = subagent.status;
				this.onChange();
				if (!this.closed && subagent.background && subagent.status !== "cancelled") this.onComplete(subagent);
			}
		});
		this.onChange();
		return subagent;
	}

	update(subagent: Subagent, activity: string): void {
		if (subagent.status !== "running") return;
		subagent.activity = activity;
		this.onChange();
	}

	stop(id?: string): SubagentInfo[] {
		if (id) this.get(id);
		const selected = new Set<string>();
		for (const subagent of this.records.values()) {
			let ancestor: Subagent | undefined = subagent;
			while (ancestor) {
				if (!id || ancestor.id === id) {
					selected.add(subagent.id);
					break;
				}
				ancestor = ancestor.parentId ? this.records.get(ancestor.parentId) : undefined;
			}
		}
		const stopped: SubagentInfo[] = [];
		for (const subagent of this.records.values()) {
			if (selected.has(subagent.id) && !subagent.settled) {
				subagent.status = "cancelled";
				subagent.activity = "Cancelling";
				subagent.output = "Subagent cancelled.";
				subagent.controller.abort();
				stopped.push(this.info(subagent));
			}
		}
		this.onChange();
		return stopped;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.stop();
		await Promise.all([...this.records.values()].map((subagent) => subagent.done));
	}
}
