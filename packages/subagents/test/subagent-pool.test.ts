import assert from "node:assert/strict";
import { test } from "node:test";
import { Subagents } from "../subagents.ts";

const input = { task: "Audit", model: "test/model", background: false };
function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

test("usage is drained once without exposing the accounting ledger in results", async () => {
	const subagents = new Subagents(() => {}, () => {});
	const first = subagents.start(input, async () => "First");
	const second = subagents.start(input, async () => "Second");
	const usage = {
		input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10,
		cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
	};
	subagents.recordUsage(first, usage);
	subagents.recordUsage(second, usage);
	assert.equal("unreportedUsage" in subagents.info(first), false);
	assert.equal(subagents.takeUsage().totalTokens, 20);
	assert.equal(subagents.takeUsage(), undefined);
	subagents.recordUsage(first, usage);
	assert.deepEqual(subagents.takeUsage(), usage);
	await subagents.close();
});

test("nested subagents share four slots and cancelled work holds its slot until settled", async () => {
	const gate = deferred();
	const subagents = new Subagents(() => {}, () => {});
	const parent = subagents.start(input, () => gate.promise);
	const child = subagents.start({ ...input, parentId: parent.id }, () => gate.promise);
	subagents.start(input, () => gate.promise);
	subagents.start(input, () => gate.promise);
	assert.throws(() => subagents.start({ ...input, parentId: child.id }, async () => ""), /All 4 subagent slots/);
	subagents.stop(parent.id);
	assert.equal(subagents.get(child.id).status, "cancelled");
	assert.equal(subagents.activeCount, 4);
	gate.resolve("late output");
	await subagents.close();
	assert.equal(subagents.activeCount, 0);
	assert.equal(parent.output, "Subagent cancelled.");
});

test("stopping one subagent stops descendants but preserves unrelated subagents", async () => {
	const gate = deferred();
	const completed = [];
	const subagents = new Subagents(() => {}, (subagent) => completed.push(subagent.id));
	const parent = subagents.start({ ...input, background: true }, () => gate.promise);
	const child = subagents.start({ ...input, background: true, parentId: parent.id }, () => gate.promise);
	const other = subagents.start({ ...input, background: true }, () => gate.promise);
	await Promise.resolve();
	assert.deepEqual(subagents.stop(parent.id).map((subagent) => subagent.id), [parent.id, child.id]);
	assert.throws(() => subagents.start({ ...input, parentId: parent.id }, async () => ""), /stopped or finished/);
	gate.resolve("Finished");
	await Promise.all([parent.done, child.done, other.done]);
	assert.deepEqual(completed, [other.id]);
	assert.equal(parent.output, "Subagent cancelled.");
	assert.equal(other.status, "completed");
});

test("background failures notify, foreground results do not, and closing suppresses late notifications", async () => {
	const notifications = [];
	const subagents = new Subagents(() => {}, (subagent) => notifications.push(subagent.status));
	const failure = subagents.start({ ...input, background: true }, async () => { throw new Error("Provider failed"); });
	await failure.done;
	assert.equal(failure.output, "Provider failed");
	const foreground = subagents.start(input, async () => "Finished");
	await foreground.done;
	assert.deepEqual(notifications, ["failed"]);
	const gate = deferred();
	subagents.start({ ...input, background: true }, () => gate.promise);
	const closing = subagents.close();
	gate.resolve("Too late");
	await closing;
	assert.deepEqual(notifications, ["failed"]);
	assert.throws(() => subagents.start(input, async () => ""), /closed/);
});
