#!/usr/bin/env node

/**
 * An extension that rewrites earlier messages in place (same count, changed
 * content) announces it on pi.events "context:rewritten". Count-based REUSE can't
 * see such an edit, so the bridge must force the next sync down the REBUILD path.
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { default: activate, __test, CONTEXT_REWRITTEN_CHANNEL } = await import("../src/index.js");

function activateWithBus() {
	const listeners = new Map();
	const events = {
		on: (channel, handler) => {
			listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
			return () => {};
		},
		emit: (channel, data) => {
			for (const handler of listeners.get(channel) ?? []) handler(data);
		},
	};
	activate({ on: () => {}, registerProvider: () => {}, registerTool: () => {}, events });
	return events;
}

const session = () => ({ sessionId: "11111111-2222-3333-4444-555555555555", cursor: 4, cwd: "/tmp" });

describe("context:rewritten", () => {
	beforeEach(() => __test.resetSharedSession());

	it("uses the documented channel name", () => {
		assert.equal(CONTEXT_REWRITTEN_CHANNEL, "context:rewritten");
	});

	it("marks the shared session for rebuild", () => {
		const events = activateWithBus();
		__test.setSharedSession(session());
		events.emit(CONTEXT_REWRITTEN_CHANNEL, { source: "self-compact", reason: "prune-freeze" });
		assert.equal(__test.getSharedSession().needsRebuild, true);
	});

	it("sends a same-count history down the REBUILD path instead of REUSE", () => {
		const events = activateWithBus();
		__test.setSharedSession(session());
		const messages = [
			{ role: "user", content: "a" }, { role: "assistant", content: [{ type: "text", text: "b" }] },
			{ role: "user", content: "c" }, { role: "assistant", content: [{ type: "text", text: "d" }] },
			{ role: "user", content: "next" },
		];
		const before = __test.syncSharedSession(messages, "/tmp");
		assert.equal(before.sessionId, session().sessionId, "without the signal, an unchanged count reuses the session");
		events.emit(CONTEXT_REWRITTEN_CHANNEL, { source: "self-compact", reason: "prune-freeze" });
		assert.equal(__test.getSharedSession().needsRebuild, true, "the signal forces the next sync to rebuild");
	});

	it("is a no-op with no shared session and tolerates a missing payload", () => {
		const events = activateWithBus();
		assert.doesNotThrow(() => events.emit(CONTEXT_REWRITTEN_CHANNEL, undefined));
		assert.equal(__test.getSharedSession(), null);
	});

	it("activates on a pi without an event bus", () => {
		assert.doesNotThrow(() => activate({ on: () => {}, registerProvider: () => {}, registerTool: () => {} }));
	});
});

describe("compaction:provided", () => {
	const { COMPACTION_PROVIDED_CHANNEL } = __test.channels;

	function activateWithHandlers() {
		const handlers = new Map(), listeners = new Map();
		const events = {
			on: (channel, handler) => { listeners.set(channel, [...(listeners.get(channel) ?? []), handler]); return () => {}; },
			emit: (channel, data) => { for (const handler of listeners.get(channel) ?? []) handler(data); },
		};
		activate({ on: (event, handler) => handlers.set(event, handler), registerProvider: () => {}, registerTool: () => {}, events });
		return { handlers, events };
	}

	const bridgeCtx = { model: { baseUrl: "claude-bridge", id: "claude-opus-5-5" }, ui: {} };
	const abortedEvent = () => {
		const controller = new AbortController();
		controller.abort();
		return {
			reason: "threshold", willRetry: false, branchEntries: [], signal: controller.signal,
			preparation: { messagesToSummarize: [], turnPrefixMessages: [], isSplitTurn: false, firstKeptEntryId: "k", tokensBefore: 1, fileOps: { read: new Set(), edited: new Set() }, settings: {} },
		};
	};

	it("uses the documented channel name", () => {
		assert.equal(COMPACTION_PROVIDED_CHANNEL, "compaction:provided");
	});

	it("without an announcement the takeover runs (an aborted run cancels)", async () => {
		const { handlers } = activateWithHandlers();
		const result = await handlers.get("session_before_compact")(abortedEvent(), bridgeCtx);
		assert.notEqual(result, undefined, "the bridge took the compaction over");
	});

	it("defers when an earlier extension announced this event's compaction", async () => {
		const { handlers, events } = activateWithHandlers();
		const event = abortedEvent();
		events.emit(COMPACTION_PROVIDED_CHANNEL, { source: "self-compact", preparation: event.preparation });
		assert.equal(await handlers.get("session_before_compact")(event, bridgeCtx), undefined);
	});

	it("an announcement for a different compaction does not suppress this one", async () => {
		const { handlers, events } = activateWithHandlers();
		events.emit(COMPACTION_PROVIDED_CHANNEL, { source: "self-compact", preparation: abortedEvent().preparation });
		assert.notEqual(await handlers.get("session_before_compact")(abortedEvent(), bridgeCtx), undefined);
	});
});
