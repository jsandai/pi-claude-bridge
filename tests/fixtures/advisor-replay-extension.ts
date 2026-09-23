// Test extension: replays a multi-message transcript through completeSimple the
// way an advisor/reviewer extension does — an unrecorded system prompt, several
// user/assistant/toolResult messages, and no tools. On a claude-bridge/* model
// this exercises the external-call reroute in streamClaudeAgentSdk plus the
// multi-message fold in extractIsolatedSummaryPrompt.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("advisor-replay", {
		description: "Replay a canned transcript through completeSimple on a bridge model",
		handler: async (_args, ctx) => {
			const model = ctx.modelRegistry.find("claude-bridge", "claude-haiku-4-5");
			if (!model) throw new Error("advisor-replay: claude-bridge/claude-haiku-4-5 not registered");

			const user = (text: string) => ({ role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() });
			const assistant = (text: string) => ({ role: "assistant" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() });
			const toolResult = (text: string) => ({
				role: "toolResult" as const,
				content: [{ type: "text" as const, text }],
				timestamp: Date.now(),
			});

			// Advisor-shape context: own rubric as systemPrompt, a transcript that
			// replays a real session — including the session's own initial system
			// message carrying toolsAdded, plus a historical toolResult. The caller
			// declares tools:[]; the transcript's embedded tools must not reclassify
			// the call as tools-present (that was the live-advisor failure).
			const context = {
				systemPrompt: "You are a transcript reviewer. In one sentence, say what the user wanted.",
				messages: [
					// Replayed session head: a real transcript's leading system message
					// with the session's tool set. normalizeContext will prepend the
					// caller's own system message (no toolsAdded) ahead of this.
					{
						role: "system",
						// Replayed session head carrying pi's harness fingerprint — the
						// "pi packages" phrase the plan-eligibility check keys on. In the
						// folded prompt this must land in the user message, not system[].
						content: "You are an expert coding assistant operating inside pi. When asked about pi packages, read the docs.",
						toolsAdded: [{ name: "bash" }, { name: "read" }],
						timestamp: Date.now(),
					},
					user("how do I reverse a string in JS?"),
					assistant("Use [...s].reverse().join(\"\")"),
					user("does that handle emoji?"),
					assistant("Let me check."),
					toolResult(" surrogate pairs split under naive reversal "),
					user("so is it safe or not?"),
				],
				tools: [],
			};

			// The advisor extension calls completeSimple through the registry's
			// runtime so the provider's registered streamSimple serves the call —
			// the same dispatch pi's agent loop uses.
			const runtime = (ctx.modelRegistry as any).runtime;
			const completeSimple = runtime?.completeSimple?.bind(runtime);
			if (!completeSimple) throw new Error("advisor-replay: modelRegistry.runtime.completeSimple unavailable");

			try {
				const result = await completeSimple(model as any, context as any, { reasoning: "low" } as any);
				const text = (result.content ?? [])
					.map((c: any) => (c.type === "text" ? c.text : ""))
					.join("");
				ctx.ui?.notify?.(`advisor-replay: stopReason=${result.stopReason} text=${text.slice(0, 200)}`, "info");
				console.log(`ADVISOR-REPLAY-RESULT stopReason=${result.stopReason} text=${text.slice(0, 300)}`);
			} catch (err) {
				ctx.ui?.notify?.(`advisor-replay: threw ${(err as Error).message.slice(0, 200)}`, "error");
				console.log(`ADVISOR-REPLAY-THREW ${(err as Error).message.slice(0, 300)}`);
			}
		},
	});
}
