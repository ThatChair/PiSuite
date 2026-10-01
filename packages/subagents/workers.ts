import { randomUUID } from "node:crypto";

export type WorkerStatus = "running" | "completed" | "failed" | "cancelled";

export interface WorkerInfo {
	id: string;
	parentId?: string;
	task: string;
	model: string;
	background: boolean;
	status: WorkerStatus;
	output: string;
	activity: string;
	startedAt: number;
	finishedAt?: number;
	tokens: number;
	cost: number;
}

export interface Worker extends WorkerInfo {
	controller: AbortController;
	done: Promise<void>;
	settled: boolean;
}

export class Workers {
	private records = new Map<string, Worker>();
	private closed = false;
	private onChange: () => void;
	private onComplete: (worker: Worker) => void;
	readonly limit: number;

	constructor(onChange: () => void, onComplete: (worker: Worker) => void, limit = 4) {
		this.onChange = onChange;
		this.onComplete = onComplete;
		this.limit = limit;
	}

	get activeCount(): number {
		return [...this.records.values()].filter((worker) => !worker.settled).length;
	}

	get(id: string): Worker {
		const worker = this.records.get(id);
		if (!worker) throw new Error(`Unknown worker: ${id}`);
		return worker;
	}

	list(): WorkerInfo[] {
		return [...this.records.values()].map((worker) => this.info(worker));
	}

	info(worker: Worker): WorkerInfo {
		const { controller: _controller, done: _done, settled: _settled, ...info } = worker;
		return info;
	}

	start(input: Pick<WorkerInfo, "task" | "model" | "background" | "parentId">, run: (worker: Worker) => Promise<string>): Worker {
		if (this.closed) throw new Error("This worker session has closed.");
		if (!input.task.trim()) throw new Error("A worker task cannot be empty.");
		if (input.parentId && this.get(input.parentId).status !== "running") {
			throw new Error("A stopped or finished worker cannot spawn children.");
		}
		// Reject rather than queue: waiting parents must not fill the pool and
		// leave their own children waiting forever for a slot.
		if (this.activeCount >= this.limit) {
			throw new Error(`All ${this.limit} worker slots are occupied. Wait for a worker to finish before spawning another.`);
		}
		const worker: Worker = {
			...input,
			id: `worker-${randomUUID()}`,
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
		this.records.set(worker.id, worker);
		worker.done = Promise.resolve().then(async () => {
			try {
				worker.controller.signal.throwIfAborted();
				const output = await run(worker);
				if (worker.status === "running") {
					worker.output = output;
					worker.status = "completed";
				}
			} catch (error) {
				if (worker.status !== "cancelled") {
					worker.status = "failed";
					worker.output = error instanceof Error ? error.message : String(error);
				}
			} finally {
				worker.settled = true;
				worker.finishedAt = Date.now();
				worker.activity = worker.status;
				this.onChange();
				if (!this.closed && worker.background && worker.status !== "cancelled") this.onComplete(worker);
			}
		});
		this.onChange();
		return worker;
	}

	update(worker: Worker, activity: string): void {
		if (worker.status !== "running") return;
		worker.activity = activity;
		this.onChange();
	}

	stop(id?: string): WorkerInfo[] {
		if (id) this.get(id);
		const selected = new Set<string>();
		for (const worker of this.records.values()) {
			let ancestor: Worker | undefined = worker;
			while (ancestor) {
				if (!id || ancestor.id === id) {
					selected.add(worker.id);
					break;
				}
				ancestor = ancestor.parentId ? this.records.get(ancestor.parentId) : undefined;
			}
		}
		const stopped: WorkerInfo[] = [];
		for (const worker of this.records.values()) {
			if (selected.has(worker.id) && !worker.settled) {
				worker.status = "cancelled";
				worker.activity = "Cancelling";
				worker.output = "Worker cancelled.";
				worker.controller.abort();
				stopped.push(this.info(worker));
			}
		}
		this.onChange();
		return stopped;
	}

	async close(): Promise<void> {
		this.closed = true;
		this.stop();
		await Promise.all([...this.records.values()].map((worker) => worker.done));
	}
}
