// External transcript-replay callers on the isolated path.
//
// completeSimple callers outside pi's agent loop (advisor/reviewer extensions)
// arrive with an unrecorded system prompt, a multi-message transcript, and no
// tools. streamClaudeAgentSdk routes them to isolatedStreamFn before any
// tool-result or orphaned-result routing, and extractIsolatedSummaryPrompt
// folds the transcript into a [role]-labeled prompt. These tests pin the
// extractor's contract and the guard conditions the reroute depends on.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { __test } from "../src/index.js";

const { extractIsolatedSummaryPrompt, promptCaptures } = __test;

function user(text) {
	return { role: "user", content: [{ type: "text", text }], timestamp: 0 };
}
function assistant(text) {
	return { role: "assistant", content: [{ type: "text", text }], timestamp: 0 };
}
function toolResult(text) {
	return { role: "toolResult", content: [{ type: "text", text }], timestamp: 0 };
}

describe("extractIsolatedSummaryPrompt", () => {
	it("passes a single user message through verbatim", () => {
		assert.equal(extractIsolatedSummaryPrompt([user("summarize this")]), "summarize this");
	});

	it("folds a multi-message transcript with [role] labels", () => {
		const out = extractIsolatedSummaryPrompt([
			user("how do I fix X?"),
			assistant("try Y"),
			user("Y failed"),
		]);
		assert.equal(out, "[user]\nhow do I fix X?\n\n[assistant]\ntry Y\n\n[user]\nY failed");
	});

	it("flattens toolResult messages to text like convertPiMessages", () => {
		const out = extractIsolatedSummaryPrompt([
			user("read file"),
			assistant(""),
			toolResult("file contents here"),
			user("now what?"),
		]);
		assert.match(out, /\[toolResult\]\nfile contents here/);
		assert.match(out, /\[user\]\nnow what\?$/);
	});

	it("accepts a toolResult tail (replayed transcript can end mid-turn)", () => {
		const out = extractIsolatedSummaryPrompt([user("q"), assistant("calling tool"), toolResult("result text")]);
		assert.match(out, /\[toolResult\]\nresult text$/);
	});

	it("accepts an assistant tail — folded text is not API prefill", () => {
		const out = extractIsolatedSummaryPrompt([user("q"), assistant("a")]);
		assert.match(out, /\[assistant\]\na$/);
	});

	it("accepts a single non-user message", () => {
		const out = extractIsolatedSummaryPrompt([assistant("a")]);
		assert.equal(out, "[assistant]\na");
	});

	it("folds replayed system messages into [system] quoted material", () => {
		const out = extractIsolatedSummaryPrompt([
			{ role: "system", content: "caller rubric", timestamp: 0 },
			{ role: "system", content: "replayed pi harness with pi packages", timestamp: 123 },
			user("q"),
		]);
		assert.match(out, /\[system\]\ncaller rubric/);
		assert.match(out, /\[system\]\nreplayed pi harness with pi packages/);
	});

	it("throws on an empty context", () => {
		assert.throws(() => extractIsolatedSummaryPrompt([]), /empty context/);
	});
});

describe("external-call reroute guard", () => {
	// The reroute in streamClaudeAgentSdk fires when resolveOrDerive misses AND
	// the call carries no tools. These tests pin both halves of that condition
	// against the real registry, so a refactor that reorders the guard or
	// changes the discriminator fails here rather than silently degrading a
	// live advisor call to a thrown turn.
	it("an unrecorded system prompt misses in resolveOrDerive", () => {
		assert.throws(
			() => promptCaptures.resolveOrDerive("a system prompt no before_agent_start recorded"),
			/prompt-capture: no capture/,
		);
	});

	it("a recorded system prompt resolves (reroute does not fire)", () => {
		const key = "recorded-prompt-key-for-test";
		promptCaptures.record(key, { contextFiles: [], skills: [] });
		const found = promptCaptures.resolveOrDerive(key);
		assert.ok(found, "recorded prompt should resolve");
	});
});
