import { describe, expect, it, vi } from "vitest";
import { buildFeedbackPayload, feedbackBody, type SessionEntry } from "../src/anthropic-feedback.ts";

describe("Anthropic feedback payload", () => {
	it("gives the refused turn Anthropic's request id, message id and stop_details", () => {
		vi.stubEnv("PI_BLACK_REQUEST_LOG", "off");
		const sessionId = "01a0f432-30fc-748f-86a1-0e9342b5570d";
		const entries: SessionEntry[] = [
			{ type: "message", id: "u1", parentId: null, timestamp: "t1", message: { role: "user", content: "paint" } },
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "t2",
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "…" }],
					responseId: "msg_refused",
					stopReason: "error",
					rawStopReason: "refusal",
					errorMessage: "This request was blocked",
				},
			},
			{
				type: "custom_message",
				id: "c1",
				parentId: "a1",
				timestamp: "t3",
				customType: "pi-black.anthropic-request",
				details: {
					ts: "t2",
					requestId: "req_refused",
					clientRequestId: "ours",
					sessionId,
					status: 200,
					messageId: "msg_refused",
					stopReason: "refusal",
					stopDetails: { type: "refusal", category: "reasoning_extraction" },
				},
			},
		];
		const payload = buildFeedbackPayload({
			sessionId,
			sessionFile: undefined,
			cwd: "/nonexistent",
			entries,
			description: "false positive",
			piVersion: "0.99.2",
		});
		vi.unstubAllEnvs();

		expect(payload).toMatchObject({
			latestAssistantMessageId: "req_refused",
			latestAssistantAPIMessageId: "msg_refused",
			surface: "pi",
			description: expect.stringContaining("not from Claude Code"),
		});
		expect((payload.transcript as unknown[])[1]).toMatchObject({
			type: "assistant",
			requestId: "req_refused",
			message: {
				id: "msg_refused",
				stop_reason: "refusal",
				stop_details: { type: "refusal", category: "reasoning_extraction" },
			},
			piErrorMessage: "This request was blocked",
		});
		expect(JSON.parse(feedbackBody(payload, sessionId))).toEqual({
			content: JSON.stringify(payload),
			session_id: sessionId,
		});
	});
});
