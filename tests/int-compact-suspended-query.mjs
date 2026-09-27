#!/usr/bin/env node
// A compaction that lands while Claude Code is parked on a tool call must reach CC.
//
// Bug it guards against: a tool that ends pi's agent loop (self-compact's
// self_compact, with terminate) leaves the CC query waiting on the MCP call,
// because the bridge only delivers tool results on pi's NEXT provider call. When
// pi compacted in between, that next call took the tool-result path and steered
// the compacted context into the OLD, uncompacted CC session. query-done then
// wrote that session back with the pre-compaction cursor and no needsRebuild, so
// the turn after resumed it again, or, with a long history, fell into the
// clean-start branch and ran with no history at all.
//
// Fix: session_before_compact supersedes the parked query, so the next call is a
// fresh query that rebuilds from the compacted history, and query-done keeps a
// needsRebuild set during the query.

console.log("=== int-compact-suspended-query.mjs ===");

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 180_000;
const CODEWORD = "ZEBRA-7731";

const testAgentDir = mkdtempSync(join(tmpdir(), "compact-suspended-agent-"));
// A tiny kept tail makes the compacted history shorter than the pre-compaction
// cursor, which is what sent the old code into the no-history clean start.
writeFileSync(join(testAgentDir, "settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 50 } }));

const harness = createRpcHarness({
	name: "compact-suspended-query",
	args: ["-e", "./tests/fixtures/handoff-compact-extension.ts", "--model", "claude-bridge/claude-haiku-4-5"],
	env: { PI_CODING_AGENT_DIR: testAgentDir },
	defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, promptAndWait, waitForEvent, collectText, DEBUG_LOG, RPC_LOG } = harness;

await startAndWait();

let failed = false;
try {
	for (const word of ["river", "lantern", "copper"]) {
		await promptAndWait(`Remember the word "${word}". Reply with just the word. Do not use the memory system.`);
	}

	console.log("Handoff turn: tool ends the loop, compaction, triggered resume turn...");
	const resumeText = collectText();
	await promptAndWait(`Call the Handoff tool once, with the note "codeword: ${CODEWORD}". Make no other tool calls.`);
	// The first agent_end is the Handoff turn; the resume turn triggered from session_compact ends second.
	await waitForEvent("agent_end", TIMEOUT);
	const resumed = resumeText.stop();

	console.log("Follow-up turn...");
	const followText = collectText();
	await promptAndWait("What was the codeword in the handoff note? Reply with just the codeword.");
	const followed = followText.stop();

	const log = readFileSync(DEBUG_LOG, "utf8");
	const beforeIdx = log.indexOf("session_before_compact:");
	if (beforeIdx === -1) throw new Error("no session_before_compact marker — did the compaction run?");
	const post = log.slice(beforeIdx);

	const firstFresh = post.indexOf("provider: fresh query setup");
	const toolResults = post.indexOf("provider: tool results");
	if (toolResults !== -1 && (firstFresh === -1 || toolResults < firstFresh)) {
		throw new Error("the resume turn was delivered into the old query as tool results");
	}

	const syncs = [...post.matchAll(/syncResult: path=(reuse|rebuild|clean-start)(?: preserve-shared)? sessionId=([a-f0-9-]+)(?: priors=\d+ (\S+))?/g)]
		.map((m) => ({ path: m[1], sessionId: m[2], flavor: m[3] }));
	console.log(`  syncResults after compaction: ${JSON.stringify(syncs)}`);
	const [resumeSync, followSync] = syncs;
	if (resumeSync?.path !== "rebuild" || resumeSync.flavor !== "rotated-post-abort") {
		throw new Error(`resume turn should rebuild into a rotated session, got ${JSON.stringify(resumeSync)}`);
	}
	if (followSync?.path !== "reuse" || followSync.sessionId !== resumeSync.sessionId) {
		throw new Error(`follow-up should resume the rebuilt session ${resumeSync.sessionId}, got ${JSON.stringify(followSync)}`);
	}
	if (/clean start for shorter context/.test(post)) {
		throw new Error("a turn after compaction took the no-history clean start");
	}
	if (!resumed.includes(CODEWORD)) throw new Error(`resume turn did not echo the codeword: ${JSON.stringify(resumed.slice(0, 200))}`);
	if (!followed.includes(CODEWORD)) throw new Error(`follow-up lost the codeword: ${JSON.stringify(followed.slice(0, 200))}`);
	if (!/superseding active query/.test(post)) {
		throw new Error("the parked Handoff query was not superseded at session_before_compact");
	}
	console.log("PASS: compaction reached CC; resume and follow-up both ran on the rebuilt session");
} catch (err) {
	failed = true;
	console.error(`FAIL: ${err.message}`);
} finally {
	await stop();
	rmSync(testAgentDir, { recursive: true, force: true });
	console.log(`  RPC log: ${RPC_LOG}`);
	console.log(`  Debug log: ${DEBUG_LOG}`);
}
process.exit(failed ? 1 : 0);
