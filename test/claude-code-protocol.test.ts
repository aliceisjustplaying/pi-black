import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context, Message } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildClaudeCodeBillingHeader,
	CLAUDE_CODE_VERSION,
	claudeCodeVersionFingerprint,
	createClaudeCodeFetch,
	discoverClaudeCodeAtis,
	discoverClaudeCodeIdentity,
	parseClaudeCodeAtis,
	parseClaudeCodeIdentity,
	patchClaudeCodeCch,
	transformClaudeCodePayload,
	xxHash64,
} from "../src/claude-code-protocol.ts";

const encoder = new TextEncoder();

let requestLogDir: string;
beforeEach(async () => {
	requestLogDir = await mkdtemp(join(tmpdir(), "pi-black-log-"));
	vi.stubEnv("PI_BLACK_REQUEST_LOG", join(requestLogDir, "requests.jsonl"));
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await rm(requestLogDir, { recursive: true, force: true });
});

describe("Anthropic request log", () => {
	const requestBody = JSON.stringify({
		model: "claude-opus-5-5",
		max_tokens: 1,
		system: [
			{
				type: "text",
				text: "x-anthropic-billing-header: cc_version=2.1.280.000; cc_entrypoint=sdk-cli; cch=00000;",
			},
		],
	});
	const readLog = async () =>
		(await readFile(join(requestLogDir, "requests.jsonl"), "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	const send = async (response: Response) => {
		const transport = vi.fn<typeof fetch>(async () => response);
		const passed = await createClaudeCodeFetch(transport)(
			"https://api.anthropic.com/v1/messages",
			{
				method: "POST",
				headers: { "x-claude-code-session-id": "session-1" },
				body: requestBody,
			},
		);
		const sentId = new Headers(transport.mock.calls[0][1]?.headers).get(
			"x-client-request-id",
		);
		return { text: await passed.text(), sentId };
	};

	it("logs ids and the stop reason from a streamed refusal without altering the stream", async () => {
		const sse = [
			'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_011CTest","stop_reason":null}}\n\n',
			'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\n',
			'event: message_stop\ndata: {"type":"message_stop"}\n\n',
		].join("");
		// Split mid-line to exercise chunk boundaries.
		const bytes = encoder.encode(sse);
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.slice(0, 57));
				controller.enqueue(bytes.slice(57));
				controller.close();
			},
		});
		const { text, sentId } = await send(
			new Response(body, {
				status: 200,
				headers: {
					"request-id": "req_011CTest",
					"content-type": "text/event-stream",
				},
			}),
		);

		expect(text).toBe(sse);
		expect(await readLog()).toEqual([
			expect.objectContaining({
				requestId: "req_011CTest",
				clientRequestId: sentId,
				sessionId: "session-1",
				status: 200,
				messageId: "msg_011CTest",
				stopReason: "refusal",
			}),
		]);
	});

	it("logs the message id and stop reason from a JSON response", async () => {
		await send(
			Response.json(
				{ type: "message", id: "msg_json", stop_reason: "end_turn" },
				{ headers: { "request-id": "req_json" } },
			),
		);
		expect(await readLog()).toEqual([
			expect.objectContaining({
				requestId: "req_json",
				messageId: "msg_json",
				stopReason: "end_turn",
			}),
		]);
	});
});
const temporaryDirectories: string[] = [];
const promptMessages = (prompt: string): Message[] => [
	{ role: "user", content: prompt, timestamp: 1 },
];
const context = (prompt: string): Context => ({
	messages: promptMessages(prompt),
});
const deviceId = "f".repeat(64);
const accountUuid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("Claude Code protocol", () => {
	it("implements standard XXH64 vectors", () => {
		expect(xxHash64(encoder.encode("")).toString(16)).toBe("ef46db3751d8e999");
		expect(xxHash64(encoder.encode("hello")).toString(16)).toBe(
			"26c7827d889f6da3",
		);
	});

	it("reproduces the recovered cc_version prompt fingerprint", async () => {
		expect(
			await claudeCodeVersionFingerprint(
				promptMessages("Reply with exactly: PROBE_OK"),
			),
		).toBe("022");
		expect(
			await buildClaudeCodeBillingHeader(
				promptMessages("Reply with exactly: PROBE_OK"),
			),
		).toBe(
			"x-anthropic-billing-header: cc_version=2.1.280.022; cc_entrypoint=sdk-cli; cch=00000;",
		);
	});

	it("discovers and validates identity from Claude Code state without exposing it", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-black-"));
		temporaryDirectories.push(root);
		const path = join(root, ".claude.json");
		const state = {
			userID: deviceId,
			oauthAccount: { accountUuid },
			clientDataCacheSlots: {
				old: {
					at: 1,
					model: "claude-opus-5",
					data: { atis: "1111111111111111" },
				},
				current: {
					at: 2,
					model: "claude-opus-5",
					data: { atis: "2222222222222222" },
				},
				otherModel: {
					at: 3,
					model: "claude-fable-5-1",
					data: { atis: "3333333333333333" },
				},
			},
		};
		await writeFile(path, JSON.stringify(state));

		expect(await discoverClaudeCodeIdentity({}, path)).toEqual({
			deviceId,
			accountUuid,
		});
		expect(await discoverClaudeCodeAtis("claude-opus-5", {}, path)).toBe(
			"2222222222222222",
		);
		expect(parseClaudeCodeAtis(state, "claude-fable-5-1")).toBe(
			"3333333333333333",
		);
		expect(parseClaudeCodeAtis(state, "claude-sonnet-5")).toBeUndefined();
		expect(
			parseClaudeCodeIdentity({ userID: "bad", oauthAccount: { accountUuid } }),
		).toBeUndefined();
	});

	it("builds billing and Agent SDK blocks first and adds discovered identity", async () => {
		const payload = await transformClaudeCodePayload(
			{
				model: "claude-opus-5",
				messages: [],
				max_tokens: 64000,
				stream: true,
				system: [
					{
						type: "text",
						text: "You are Claude Code, Anthropic's official CLI for Claude.",
					},
					{
						type: "text",
						text: "Pi system",
						cache_control: { type: "ephemeral" },
					},
				],
			},
			context("Reply with exactly: PROBE_OK"),
			"11111111-2222-4333-8444-555555555555",
			{ deviceId, accountUuid },
		);
		const system = payload.system as Array<Record<string, unknown>>;
		expect(system[0]).toEqual({
			type: "text",
			text: "x-anthropic-billing-header: cc_version=2.1.280.022; cc_entrypoint=sdk-cli; cch=00000;",
		});
		expect(system[1]).toEqual({
			type: "text",
			text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
		});
		expect(system[2]).toEqual({
			type: "text",
			text: "You are powered by the model named Opus 5. The exact model ID is claude-opus-5. Assistant knowledge cutoff is May 2026.",
		});
		expect(system[3]).toEqual({
			type: "text",
			text: "Pi system",
			cache_control: { type: "ephemeral" },
		});
		expect(payload.metadata).toEqual({
			user_id: JSON.stringify({
				device_id: deviceId,
				account_uuid: accountUuid,
				session_id: "11111111-2222-4333-8444-555555555555",
			}),
		});
	});

	it("adds the Claude Code model identity and cutoff once for verified models", async () => {
		const first = await transformClaudeCodePayload(
			{
				model: "claude-fable-5-1",
				messages: [],
				max_tokens: 1,
				stream: true,
				system: [{ type: "text", text: "Pi system" }],
			},
			context("hello"),
			undefined,
			undefined,
		);
		const second = await transformClaudeCodePayload(
			first,
			context("hello"),
			undefined,
			undefined,
		);
		const system = second.system as Array<{ text: string }>;
		const modelContext =
			"You are powered by the model named Fable 5.1. The exact model ID is claude-fable-5-1. Assistant knowledge cutoff is June 2026.";
		expect(system[2]?.text).toBe(modelContext);
		expect(system.filter((block) => block.text === modelContext)).toHaveLength(1);
		expect(system[3]?.text).toBe("Pi system");

		for (const [model, expected] of [
			[
				"claude-opus-5",
				"You are powered by the model named Opus 5. The exact model ID is claude-opus-5. Assistant knowledge cutoff is May 2026.",
			],
			[
				"claude-sonnet-5",
				"You are powered by the model named Sonnet 5. The exact model ID is claude-sonnet-5. Assistant knowledge cutoff is January 2026.",
			],
		] as const) {
			const result = await transformClaudeCodePayload(
				{ model, messages: [], max_tokens: 1, stream: true },
				context("hello"),
				undefined,
				undefined,
			);
			expect((result.system as Array<{ text: string }>)[2]?.text).toBe(expected);
		}
	});

	it("does not duplicate blocks when the retained source patch is also present", async () => {
		const first = await transformClaudeCodePayload(
			{
				model: "claude-opus-5",
				messages: [],
				max_tokens: 1,
				stream: true,
				system: [{ type: "text", text: "Pi system" }],
			},
			context("hello"),
			undefined,
			undefined,
		);
		const second = await transformClaudeCodePayload(
			first,
			context("hello"),
			undefined,
			undefined,
		);
		expect(second.system).toEqual(first.system);
	});

	it("omits identity metadata when Claude Code state is unavailable", async () => {
		const payload = await transformClaudeCodePayload(
			{ model: "claude-opus-5", messages: [], max_tokens: 1, stream: true },
			context("hello"),
			"11111111-2222-4333-8444-555555555555",
			undefined,
		);
		expect(payload).not.toHaveProperty("metadata");
	});

	it("reproduces the recovered normalized-body checksum", () => {
		const body =
			'{"model":"claude-opus-5","messages":[{"role":"user","content":"A"}],"max_tokens":64000,"stream":true,"system":[{"type":"text","text":"x-anthropic-billing-header: cc_version=2.1.280.000; cc_entrypoint=sdk-cli; cch=00000;"}]}';
		expect(patchClaudeCodeCch(body)).toContain("cch=5efff");
	});

	it("patches only the first billing block despite placeholder and nested-field collisions", () => {
		const body = {
			model: "claude-opus-5",
			messages: [
				{
					role: "user",
					content: "cch=00000",
					model: "nested-model",
					max_tokens: 7,
				},
			],
			max_tokens: 64000,
			stream: true,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.280.000; cc_entrypoint=sdk-cli; cch=00000;",
				},
				{ type: "text", text: "fake cch=00000" },
			],
			tools: [
				{
					name: "probe",
					description: "model max_tokens cch=00000",
					input_schema: { type: "object" },
				},
			],
		};
		const patched = JSON.parse(
			patchClaudeCodeCch(JSON.stringify(body)),
		) as typeof body;
		expect(patched.system[0].text).toMatch(/cch=[0-9a-f]{5};$/u);
		expect(patched.system[0].text).not.toContain("cch=00000");
		expect(patched.messages[0]).toEqual(body.messages[0]);
		expect(patched.system[1]).toEqual(body.system[1]);
		expect(patched.tools).toEqual(body.tools);
	});

	it("leaves an already patched billing value unchanged", () => {
		const body = JSON.stringify({
			model: "claude-opus-5",
			messages: [],
			max_tokens: 1,
			stream: true,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.280.000; cc_entrypoint=sdk-cli; cch=abc12;",
				},
			],
		});
		expect(patchClaudeCodeCch(body)).toBe(body);
	});

	it("patches the final SDK body and generates a request UUID", async () => {
		const body = JSON.stringify({
			model: "claude-opus-5",
			messages: [],
			max_tokens: 1,
			stream: true,
			system: [
				{
					type: "text",
					text: "x-anthropic-billing-header: cc_version=2.1.280.000; cc_entrypoint=sdk-cli; cch=00000;",
				},
			],
		});
		const transport = vi.fn<typeof fetch>(
			async () => new Response(null, { status: 200 }),
		);
		await createClaudeCodeFetch(
			transport,
			Promise.resolve("0123456789abcdef"),
		)(
			"https://api.anthropic.com/v1/messages",
			{
				method: "POST",
				headers: { authorization: "Bearer secret" },
				body,
			},
		);

		const [, init] = transport.mock.calls[0];
		expect(String(init?.body)).toMatch(/cch=[0-9a-f]{5}/u);
		const headers = new Headers(init?.headers);
		expect(headers.get("x-client-request-id")).toMatch(/^[0-9a-f-]{36}$/u);
		expect(headers.get("authorization")).toBe("Bearer secret");
		expect(headers.get("x-cc-atis")).toBe("0123456789abcdef");

		await createClaudeCodeFetch(transport, "0123456789abcdef")(
			"https://proxy.example.com/v1/messages",
			{ method: "POST", body },
		);
		const [, proxyInit] = transport.mock.calls[1];
		expect(new Headers(proxyInit?.headers).get("x-cc-atis")).toBeNull();
	});
});
