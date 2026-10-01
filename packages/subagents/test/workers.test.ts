import assert from "node:assert/strict";
import { test } from "node:test";
import { Workers } from "../workers.ts";

const input = { task: "Audit", model: "test/model", background: false };
function deferred() {
	let resolve;
	const promise = new Promise((r) => { resolve = r; });
	return { promise, resolve };
}

test("nested workers share four slots and cancelled work holds its slot until settled", async () => {
	const gate = deferred();
	const workers = new Workers(() => {}, () => {});
	const parent = workers.start(input, () => gate.promise);
	const child = workers.start({ ...input, parentId: parent.id }, () => gate.promise);
	workers.start(input, () => gate.promise);
	workers.start(input, () => gate.promise);
	assert.throws(() => workers.start({ ...input, parentId: child.id }, async () => ""), /All 4 worker slots/);
	workers.stop(parent.id);
	assert.equal(workers.get(child.id).status, "cancelled");
	assert.equal(workers.activeCount, 4);
	gate.resolve("late output");
	await workers.close();
	assert.equal(workers.activeCount, 0);
	assert.equal(parent.output, "Worker cancelled.");
});

test("stopping one worker stops descendants but preserves unrelated workers", async () => {
	const gate = deferred();
	const completed = [];
	const workers = new Workers(() => {}, (worker) => completed.push(worker.id));
	const parent = workers.start({ ...input, background: true }, () => gate.promise);
	const child = workers.start({ ...input, background: true, parentId: parent.id }, () => gate.promise);
	const other = workers.start({ ...input, background: true }, () => gate.promise);
	await Promise.resolve();
	assert.deepEqual(workers.stop(parent.id).map((worker) => worker.id), [parent.id, child.id]);
	assert.throws(() => workers.start({ ...input, parentId: parent.id }, async () => ""), /stopped or finished/);
	gate.resolve("Finished");
	await Promise.all([parent.done, child.done, other.done]);
	assert.deepEqual(completed, [other.id]);
	assert.equal(parent.output, "Worker cancelled.");
	assert.equal(other.status, "completed");
});

test("background failures notify, foreground results do not, and closing suppresses late notifications", async () => {
	const notifications = [];
	const workers = new Workers(() => {}, (worker) => notifications.push(worker.status));
	const failure = workers.start({ ...input, background: true }, async () => { throw new Error("Provider failed"); });
	await failure.done;
	assert.equal(failure.output, "Provider failed");
	const foreground = workers.start(input, async () => "Finished");
	await foreground.done;
	assert.deepEqual(notifications, ["failed"]);
	const gate = deferred();
	workers.start({ ...input, background: true }, () => gate.promise);
	const closing = workers.close();
	gate.resolve("Too late");
	await closing;
	assert.deepEqual(notifications, ["failed"]);
	assert.throws(() => workers.start(input, async () => ""), /closed/);
});
