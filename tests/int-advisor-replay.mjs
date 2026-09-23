#!/usr/bin/env node
// External transcript-replay callers on the isolated path, end to end against a
// real Claude Code subprocess.
//
// An advisor/reviewer extension calls completeSimple with its own system
// prompt, a multi-message transcript (including a historical toolResult), and
// no tools. Before this change the call threw twice over: resolveOrDerive on
// the unrecorded prompt, then extractIsolatedSummaryPrompt on the message
// count. The reroute + fold should now serve it as an isolated query.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TEST_TIMEOUT = 120_000;

const harness = createRpcHarness({
	name: "advisor-replay",
	args: [
		"-e", "./tests/fixtures/advisor-replay-extension.ts",
		"--model", "claude-bridge/claude-haiku-4-5",
	],
	defaultTimeout: TEST_TIMEOUT,
});

describe("external transcript-replay via completeSimple", () => {
	const { startAndWait, stop, send, promptAndWait, DEBUG_LOG } = harness;

	before(async () => { await startAndWait(); });
	after(async () => { await stop(); });

	async function waitForLog(mark, pattern, timeout = 90_000) {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			const slice = readFileSync(DEBUG_LOG, "utf8").slice(mark);
			if (pattern.test(slice)) return slice;
			await sleep(500);
		}
		return readFileSync(DEBUG_LOG, "utf8").slice(mark);
	}

	it("serves a multi-message no-tools call on the isolated path", { timeout: TEST_TIMEOUT }, async () => {
		// A live turn first so the session has an active query history — the
		// replay must not be mistaken for a tool-result delivery into it.
		await promptAndWait("Reply with exactly the word READY and nothing else.");

		const mark = statSync(DEBUG_LOG).size;
		await send({ type: "prompt", message: "/advisor-replay" });

		// The bridge's own log proves the reroute + isolated path served the call.
		const debugSlice = await waitForLog(mark, /external call: done|routing to isolated query/);
		assert.match(debugSlice, /routing to isolated query/, `no reroute evidence:\n${debugSlice.slice(-1500)}`);
		assert.match(debugSlice, /external call: done textLen=[1-9]/, `isolated query did not complete:\n${debugSlice.slice(-1500)}`);

		// The extension's notify reaches the RPC log as an extension_ui_request;
		// a thrown call would surface there as an error notify instead. Scope the
		// no-throw check to the advisor segment — earlier turns' thinking blocks
		// can contain the literal word "threw".
		// RPC log is append-mode across runs — scope to the LAST /advisor-replay
		// so a stale error from a previous failing run can't trip the check.
		const rpcLog = readFileSync(DEBUG_LOG.replace("-debug.log", ".log"), "utf8");
		const advisorSegment = rpcLog.slice(rpcLog.lastIndexOf("/advisor-replay"));
		assert.match(advisorSegment, /advisor-replay: stopReason=stop/, `advisor call did not stop cleanly:\n${advisorSegment.slice(-1500)}`);
		assert.doesNotMatch(advisorSegment, /advisor-replay: threw/, `advisor call threw:\n${advisorSegment.slice(-1500)}`);
	});
});
