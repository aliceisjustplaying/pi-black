import type { Provider } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createClaudeCodeFetch } from "../src/claude-code-protocol.ts";
import piBlack from "../extensions/pi-black.ts";
import {
	isSupportedPiVersion,
	MINIMUM_SUPPORTED_PI_VERSION,
} from "../src/compatibility.ts";

describe("Pi Black extension", () => {
	it("registers the wrapped Anthropic provider with the installed Pi version", () => {
		expect(isSupportedPiVersion(VERSION)).toBe(true);
		if (process.env.EXPECTED_PI_VERSION)
			expect(VERSION).toBe(process.env.EXPECTED_PI_VERSION);
		const registerProvider = vi.fn<(provider: Provider) => void>();

		piBlack({ registerProvider, on: vi.fn(), registerCommand: vi.fn() } as unknown as ExtensionAPI);

		expect(registerProvider).toHaveBeenCalledOnce();
		expect(registerProvider.mock.calls[0][0].id).toBe("anthropic");
	});

	it("supports the minimum Pi version and newer stable versions", () => {
		expect(MINIMUM_SUPPORTED_PI_VERSION).toBe("1.0.0");
		for (const version of ["1.0.0", "1.0.1", "1.2.0", "2.0.0"])
			expect(isSupportedPiVersion(version)).toBe(true);
	});

	it("rejects Pi versions below the minimum or with an invalid format", () => {
		for (const version of [
			"0.85.0",
			"0.99.999",
			"1.0",
			"1.0.0-beta.1",
			"invalid",
		])
			expect(isSupportedPiVersion(version)).toBe(false);
	});
});

describe("Anthropic request recording", () => {
	it("records each request of the session as a custom entry, sends no message, and keeps earlier hidden messages out of model context", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-black-ext-"));
		vi.stubEnv("PI_BLACK_REQUEST_LOG", join(dir, "requests.jsonl"));
		const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
		const sendMessage = vi.fn();
		const appendEntry = vi.fn();
		const pi = {
			registerProvider: vi.fn(),
			registerCommand: vi.fn(),
			sendMessage,
			appendEntry,
			on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
		};
		try {
			piBlack(pi as unknown as ExtensionAPI);
			handlers.get("session_start")?.({}, { sessionManager: { getSessionId: () => "session-1" } });

			const request = (session: string) =>
				createClaudeCodeFetch(async () =>
					Response.json(
						{ type: "message", id: `msg_${session}`, stop_reason: "refusal" },
						{ headers: { "request-id": `req_${session}` } },
					),
				)("https://api.anthropic.com/v1/messages", {
					method: "POST",
					headers: { "x-claude-code-session-id": session },
					body: JSON.stringify({
						model: "claude-opus-5-5",
						max_tokens: 1,
						system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.287.000; cc_entrypoint=sdk-cli; cch=00000;" }],
					}),
				}).then((response) => response.text());
			await request("session-1");
			await request("other-session");

			// A message after the reply would be the run's last message, and `pi --print` prints
			// only when the last message is the assistant's.
			expect(sendMessage).not.toHaveBeenCalled();
			expect(appendEntry).toHaveBeenCalledOnce();
			const [customType, data] = appendEntry.mock.calls[0];
			expect(customType).toBe("anthropic-request");
			expect(data).toMatchObject({ requestId: "req_session-1", messageId: "msg_session-1", stopReason: "refusal" });

			const user = { role: "user", content: "hi", timestamp: 1 };
			const recorded = { role: "custom", customType, content: "Anthropic req_session-1", display: false, details: data, timestamp: 2 };
			expect(handlers.get("context")?.({ messages: [user, recorded] }, {})).toEqual({ messages: [user] });
		} finally {
			handlers.get("session_shutdown")?.({}, {});
			vi.unstubAllEnvs();
			await rm(dir, { recursive: true, force: true });
		}
	});
});
