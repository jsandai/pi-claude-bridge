/**
 * Contained mode (PI_CLAUDE_BRIDGE_CONTAINED=1): Claude Code is only a model endpoint for an isolated worker.
 * Live canaries (2026-10-02, claude-sonnet-5-5): a project `.claude/settings.json` hook fired in normal mode and
 * not in contained mode; `@/tmp/<secret>` in the prompt was read by Claude Code in both modes until mentions were
 * neutralized, after which the model answered NOSEE.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { containedEnv, isContained, loadConfig } from "../src/config.js";
import { neutralizeMentions, userMessage } from "../src/prompt-stream.js";

function withEnv(vars, fn) {
	const old = {};
	for (const k of Object.keys(vars)) {
		old[k] = process.env[k];
		if (vars[k] === undefined) delete process.env[k];
		else process.env[k] = vars[k];
	}
	try { return fn(); } finally {
		for (const k of Object.keys(old)) {
			if (old[k] === undefined) delete process.env[k];
			else process.env[k] = old[k];
		}
	}
}

describe("contained mode", () => {
	it("is on only for exactly \"1\"", () => {
		assert.equal(isContained({ PI_CLAUDE_BRIDGE_CONTAINED: "1" }), true);
		for (const v of [undefined, "", "0", "true", "yes"]) assert.equal(isContained({ PI_CLAUDE_BRIDGE_CONTAINED: v }), false, String(v));
	});

	it("ignores the project config, drops pathToClaudeCodeExecutable, forces strict MCP + no auto-memory, never enables AskClaude", () => {
		const agent = mkdtempSync(join(tmpdir(), "ccb-agent-"));
		const cwd = mkdtempSync(join(tmpdir(), "ccb-cwd-"));
		try {
			writeFileSync(join(agent, "claude-bridge.json"), JSON.stringify({
				askClaude: { enabled: true },
				provider: { plan: "max", pathToClaudeCodeExecutable: "/global/claude", strictMcpConfig: false, autoMemoryEnabled: true },
			}));
			mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
			writeFileSync(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"), JSON.stringify({
				askClaude: { enabled: true }, provider: { pathToClaudeCodeExecutable: "/evil/claude" },
			}));
			withEnv({ PI_CODING_AGENT_DIR: agent }, () => {
				const normal = loadConfig(cwd, {});
				assert.equal(normal.provider.pathToClaudeCodeExecutable, "/evil/claude"); // the hole contained mode closes
				const c = loadConfig(cwd, { PI_CLAUDE_BRIDGE_CONTAINED: "1" });
				assert.deepEqual(c.askClaude, {});
				// strict MCP and no auto-memory are forced on, whatever the global config asked for
				assert.deepEqual(c.provider, { plan: "max", strictMcpConfig: true, autoMemoryEnabled: false });
			});
		} finally {
			rmSync(agent, { recursive: true, force: true });
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("passes Claude Code only what it needs to start and authenticate", () => {
		const env = containedEnv({
			HOME: "/h", PATH: "/p", LANG: "C", LC_ALL: "C", XDG_CONFIG_HOME: "/x", HTTPS_PROXY: "p",
			CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_OAUTH_TOKEN: "t",
			ANTHROPIC_API_KEY: "k", HIVE_API_KEY: "h", GITHUB_TOKEN: "g", NODE_OPTIONS: "--require /evil.js", AWS_SECRET_ACCESS_KEY: "a",
		});
		assert.deepEqual(Object.keys(env).sort(), ["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HOME", "HTTPS_PROXY", "LANG", "LC_ALL", "PATH", "XDG_CONFIG_HOME"]);
	});

	it("neutralizes every @ that could open a mention, and only in contained mode", () => {
		assert.equal(neutralizeMentions("read @/etc/x and @~/.ssh/id, mail a@b.c; lone @ stays"), "read @​/etc/x and @​~/.ssh/id, mail a@​b.c; lone @ stays");
		const blocks = [{ type: "text", text: "see @/tmp/s" }, { type: "image", source: { data: "@x" } }];
		withEnv({ PI_CLAUDE_BRIDGE_CONTAINED: "1" }, () => {
			const m = userMessage(blocks);
			assert.equal(m.message.content[0].text, "see @​/tmp/s");
			assert.deepEqual(m.message.content[1], blocks[1]); // non-text blocks untouched
			assert.equal(userMessage("x @/y").message.content, "x @​/y");
		});
		withEnv({ PI_CLAUDE_BRIDGE_CONTAINED: undefined }, () => {
			assert.equal(userMessage(blocks).message.content[0].text, "see @/tmp/s");
		});
	});
});
