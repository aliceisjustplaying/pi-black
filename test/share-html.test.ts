import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/anthropic-feedback.ts";
import type { AnthropicRequestLogEntry } from "../src/claude-code-protocol.ts";
import { idsByEntry } from "../src/share-html.ts";

const at = (offset: number): string =>
	new Date(Date.UTC(2026, 0, 1, 0, 0, offset)).toISOString();

type AssistantOverrides = {
	stopReason?: string;
	responseId?: string;
	provider?: string;
	api?: string;
};

const user = (id: string, offset: number): SessionEntry => ({
	type: "message",
	id,
	timestamp: at(offset),
	message: { role: "user", content: "hi", timestamp: Date.parse(at(offset)) },
});

const assistant = (id: string, offset: number, o: AssistantOverrides = {}): SessionEntry => ({
	type: "message",
	id,
	timestamp: at(offset),
	message: {
		role: "assistant",
		content: [{ type: "text", text: "..." }],
		timestamp: Date.parse(at(offset)),
		...(o.responseId ? { responseId: o.responseId } : {}),
		...(o.stopReason ? { stopReason: o.stopReason } : {}),
		...(o.provider ? { provider: o.provider } : {}),
		...(o.api ? { api: o.api } : {}),
	},
});

const request = (
	requestId: string,
	offset: number,
	extra: Partial<AnthropicRequestLogEntry> = {},
): AnthropicRequestLogEntry => ({
	ts: at(offset),
	requestId,
	clientRequestId: null,
	sessionId: "s",
	status: 200,
	...extra,
});

describe("shared HTML id attribution", () => {
	it("matches an assistant to its request by message id", () => {
		const ids = idsByEntry(
			[
				user("u1", 0),
				assistant("a1", 10, { responseId: "msg_abc", provider: "anthropic" }),
			],
			[request("req_1", 5, { messageId: "msg_abc", status: 200 })],
		);
		expect(ids.a1).toEqual({
			requestId: "req_1",
			messageId: "msg_abc",
			stopReason: undefined,
		});
	});

	it("attributes a failed request to the error it caused", () => {
		const ids = idsByEntry(
			[user("u1", 0), assistant("a1", 10, { stopReason: "error", provider: "anthropic" })],
			[request("req_1", 5, { status: 400, error: { message: "bad" } })],
		);
		expect(ids.a1).toEqual({
			requestId: "req_1",
			messageId: null,
			stopReason: "HTTP 400",
		});
	});

	it("does not hand an Anthropic request to another provider's error", () => {
		const ids = idsByEntry(
			[
				user("u1", 0),
				assistant("a1", 10, { stopReason: "error", provider: "openai", api: "openai-responses" }),
			],
			[request("req_1", 5, { status: 400, error: { message: "bad" } })],
		);
		expect(ids.a1).toBeUndefined();
	});

	it("does not attribute a successful request to an error", () => {
		const ids = idsByEntry(
			[user("u1", 0), assistant("a1", 10, { stopReason: "error", provider: "anthropic" })],
			[request("req_ok", 5, { status: 200, stopReason: "end_turn" })],
		);
		// A blank annotation is the honest outcome; "HTTP 200" is not.
		expect(ids.a1).toBeUndefined();
	});

	it("does not adopt a failure from an earlier turn", () => {
		const ids = idsByEntry(
			[
				user("u1", 0),
				assistant("a1", 10, { stopReason: "error", provider: "anthropic" }),
				user("u2", 20),
				assistant("a2", 30, { stopReason: "error", provider: "anthropic" }),
			],
			[
				request("req_old", 5, { status: 400, error: { message: "old" } }),
				request("req_new", 25, { status: 429, streamError: "rate limited" }),
			],
		);
		expect(ids.a1?.requestId).toBe("req_old");
		expect(ids.a2?.requestId).toBe("req_new");
	});

	it("never assigns one request to two errors", () => {
		const ids = idsByEntry(
			[
				user("u1", 0),
				assistant("a1", 10, { stopReason: "error", provider: "anthropic" }),
				user("u2", 20),
				assistant("a2", 30, { stopReason: "error", provider: "anthropic" }),
			],
			[request("req_only", 5, { status: 500, error: { message: "boom" } })],
		);
		const claimed = Object.values(ids).filter((v) => v.requestId === "req_only");
		expect(claimed).toHaveLength(1);
	});

	it("does not adopt an unclaimed failure from an earlier turn", () => {
		// The earlier failure belongs to a turn that was annotated by message id, so
		// it stays unused. Without a turn floor the later error would adopt it.
		const ids = idsByEntry(
			[
				user("u1", 0),
				assistant("a1", 10, { responseId: "msg_ok", provider: "anthropic" }),
				user("u2", 20),
				assistant("a2", 30, { stopReason: "error", provider: "anthropic" }),
			],
			[request("req_old", 5, { status: 400, error: { message: "old" } })],
		);
		expect(ids.a2).toBeUndefined();
	});

	it("leaves an error unannotated when nothing failed in its turn", () => {
		const ids = idsByEntry(
			[
				user("u1", 0),
				assistant("a1", 10, { stopReason: "error", provider: "anthropic" }),
				user("u2", 20),
				assistant("a2", 30, { responseId: "msg_ok", provider: "anthropic" }),
			],
			[request("req_ok", 25, { messageId: "msg_ok", status: 200 })],
		);
		expect(ids.a1).toBeUndefined();
		expect(ids.a2?.requestId).toBe("req_ok");
	});

	it("still attributes when the session predates provider tagging", () => {
		const ids = idsByEntry(
			[user("u1", 0), assistant("a1", 10, { stopReason: "error" })],
			[request("req_1", 5, { status: 400, error: { message: "bad" } })],
		);
		expect(ids.a1?.requestId).toBe("req_1");
	});
});