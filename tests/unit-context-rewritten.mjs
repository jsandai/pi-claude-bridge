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
