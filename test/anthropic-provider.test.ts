import type {
	Api,
	ApiStreamOptions,
	AssistantMessageEventStream,
	Model,
	Provider,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { wrapAnthropicProvider } from "../src/anthropic-provider.ts";
import { CLAUDE_CODE_VERSION } from "../src/claude-code-protocol.ts";

const context = normalizeContext({
	systemPrompt: "Pi system",
	messages: [
		{ role: "user", content: "Reply with exactly: PROBE_OK", timestamp: 1 },
	],
});
const model = {
	id: "claude-test",
	provider: "anthropic",
	api: "anthropic-messages",
} as Model<Api>;
const streamResult = {} as AssistantMessageEventStream;

function fakeProvider() {
	let streamOptions: ApiStreamOptions<Api> | undefined;
	let simpleOptions: SimpleStreamOptions | undefined;
	const provider = {
		id: "anthropic",
		name: "Anthropic",
		stream<T extends Api>(
			_model: Model<T>,
			_context: TranscriptContext,
			options?: ApiStreamOptions<T>,
		) {
			streamOptions = options;
			return streamResult;
		},
		streamSimple(
			_model: Model<Api>,
			_context: TranscriptContext,
			options?: SimpleStreamOptions,
		) {
			simpleOptions = options;
			return streamResult;
		},
	} as Provider;
	return {
		provider,
		getStreamOptions: () => streamOptions,
		getSimpleOptions: () => simpleOptions,
	};
}

describe("Anthropic provider wrapper", () => {
	it("passes API-key requests through without changing options", () => {
		const fake = fakeProvider();
		const wrapped = wrapAnthropicProvider(fake.provider, undefined);
		const options: SimpleStreamOptions = {
			apiKey: "sk-ant-api-key",
			headers: { "x-test": "yes" },
		};
		wrapped.streamSimple(model, context, options);
		expect(fake.getSimpleOptions()).toBe(options);
	});

	it("applies existing payload transforms before the final Pi Black transform", async () => {
		const fake = fakeProvider();
		const resolveAtis = vi.fn(() => "0123456789abcdef");
		const wrapped = wrapAnthropicProvider(
			fake.provider,
			{
				deviceId: "f".repeat(64),
				accountUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			},
			resolveAtis,
		);
		const priorTransform = vi.fn(async (payload: unknown) => ({
			...(payload as object),
			later_extension: true,
		}));
		wrapped.streamSimple(model, context, {
			apiKey: "sk-ant-oat-test",
			sessionId: "11111111-2222-4333-8444-555555555555",
			onPayload: priorTransform,
		});
		const options = fake.getSimpleOptions();
		const payload = await options?.onPayload?.(
			{
				model: "claude-test",
				messages: [],
				max_tokens: 1,
				stream: true,
				system: [
					{
						type: "text",
						text: "You are Claude Code, Anthropic's official CLI for Claude.",
					},
				],
			},
			model,
		);
		expect(priorTransform).toHaveBeenCalledOnce();
		expect(payload).toMatchObject({ later_extension: true });
		const system = (payload as { system: Array<{ text: string }> }).system;
		expect(system[0].text).toMatch(/^x-anthropic-billing-header:/u);
		expect(system[1].text).toBe(
			"You are a Claude agent, built on Anthropic's Claude Agent SDK.",
		);
		expect(options?.headers).toMatchObject({
			"user-agent": `claude-cli/${CLAUDE_CODE_VERSION} (external, sdk-cli)`,
			"x-app": "cli",
			"x-claude-code-session-id": "11111111-2222-4333-8444-555555555555",
		});
		expect(resolveAtis).toHaveBeenCalledOnce();
		expect(resolveAtis).toHaveBeenCalledWith("claude-test");

		wrapped.streamSimple(model, context, { apiKey: "sk-ant-oat-test" });
		expect(resolveAtis).toHaveBeenCalledOnce();
	});

	it("resolves ATIS per model instead of latching the first result", async () => {
		const fake = fakeProvider();
		// Opus 5.5 has no assignment; Fable 5.1 does. Latching the first result
		// would leave Fable without the header for the rest of the process.
		const assignments: Record<string, string | undefined> = {
			"claude-opus-5-5": undefined,
			"claude-fable-5-1": "d5ce23808f17634f",
		};
		const resolveAtis = vi.fn((modelId: string) => assignments[modelId]);
		const wrapped = wrapAnthropicProvider(
			fake.provider,
			{
				deviceId: "f".repeat(64),
				accountUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			},
			resolveAtis,
		);
		const opus = { ...model, id: "claude-opus-5-5" } as Model<Api>;
		const fable = { ...model, id: "claude-fable-5-1" } as Model<Api>;

		const atisFor = async (target: Model<Api>) => {
			const transport = vi.fn(
				async (_input: RequestInfo | URL, _init?: RequestInit) =>
					new Response(null, { status: 200 }),
			);
			wrapped.streamSimple(target, context, {
				apiKey: "sk-ant-oat-test",
				sessionId: "11111111-2222-4333-8444-555555555555",
				fetch: transport,
			});
			await fake.getSimpleOptions()?.fetch?.(
				"https://api.anthropic.com/v1/messages",
				{
					method: "POST",
					body: JSON.stringify({
						model: target.id,
						messages: [],
						max_tokens: 1,
						stream: true,
						system: [
							{
								type: "text",
								text: `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}.000; cc_entrypoint=sdk-cli; cch=00000;`,
							},
						],
					}),
				},
			);
			const headers = new Headers(transport.mock.calls[0]?.[1]?.headers);
			return headers.get("x-cc-atis") ?? undefined;
		};

		expect(await atisFor(opus)).toBeUndefined();
		expect(await atisFor(fable)).toBe("d5ce23808f17634f");
		expect(resolveAtis).toHaveBeenCalledTimes(2);
	});
});
