// Test extension: the self-compact shape. A tool that ends pi's agent loop
// (terminate) while Claude Code is still parked on the MCP call, a compaction
// when the agent goes idle, and a turn triggered from session_compact.
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	let pending: string | null = null;
	const params = Type.Object({
		note: Type.String({ description: "The handoff note to carry across compaction" }),
	});
	pi.registerTool<typeof params>({
		name: "Handoff",
		label: "Save a handoff note and compact",
		description: "Saves a handoff note, then compacts the session when this turn ends. Use this when asked to hand off.",
		parameters: params,
		async execute(_id, params) {
			pending = params.note;
			return {
				content: [{ type: "text" as const, text: "Note saved. Compaction runs when this turn ends." }],
				details: {},
				terminate: true,
			};
		},
	});
	// Deferred until the agent is idle, as self-compact does. Compacting from inside
	// agent_end aborts the run first, and the abort path rebuilds on its own, which
	// hides the bug this fixture exists to reproduce.
	pi.on("agent_end", async (_event, ctx) => {
		if (pending === null) return;
		const tryCompact = () => (ctx.isIdle() ? ctx.compact({}) : setTimeout(tryCompact, 25));
		setTimeout(tryCompact, 25);
	});
	pi.on("session_compact", async () => {
		if (pending === null) return;
		const note = pending;
		pending = null;
		pi.sendMessage(
			{ customType: "handoff-test", content: `Handoff note written before compaction:\n${note}\n\nReply with just the codeword from the note.`, display: true },
			{ triggerTurn: true },
		);
	});
}
