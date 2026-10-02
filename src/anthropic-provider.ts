import type {
	Api,
	ApiStreamOptions,
	Model,
	Provider,
	SimpleStreamOptions,
	TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	type ClaudeCodeIdentity,
	discoverClaudeCodeAtis,
	discoverClaudeCodeIdentity,
	isAnthropicOAuthToken,
	mergeClaudeCodeOptions,
} from "./claude-code-protocol.ts";

export function wrapAnthropicProvider(
	provider: Provider,
	identity:
		| ClaudeCodeIdentity
		| undefined
		| Promise<ClaudeCodeIdentity | undefined> = discoverClaudeCodeIdentity(),
	resolveAtis: (
		modelId: string,
	) => string | undefined | Promise<string | undefined> = discoverClaudeCodeAtis,
): Provider {
	if (provider.id !== "anthropic")
		throw new Error(`Pi Black cannot wrap provider "${provider.id}"`);

	// ATIS assignments are per-model, so the latch has to be keyed by model ID.
	// A single process-level latch would pin whatever the first request resolved
	// to: if that model has no assignment, every later model would be left
	// without the header even though the server assigned it one.
	const atisLatches = new Map<string, Promise<string | undefined>>();
	const latchedAtis = (modelId: string) => {
		let atisLatch = atisLatches.get(modelId);
		if (!atisLatch) {
			atisLatch = Promise.resolve(resolveAtis(modelId));
			atisLatches.set(modelId, atisLatch);
		}
		return atisLatch;
	};

	return {
		...provider,
		stream<T extends Api>(
			model: Model<T>,
			context: TranscriptContext,
			options?: ApiStreamOptions<T>,
		) {
			if (!options || !isAnthropicOAuthToken(options.apiKey))
				return provider.stream(model, context, options);
			const transformed = mergeClaudeCodeOptions(
				options,
				context,
				identity,
				latchedAtis(model.id),
			);
			return provider.stream(model, context, transformed);
		},
		streamSimple(
			model: Model<Api>,
			context: TranscriptContext,
			options?: SimpleStreamOptions,
		) {
			if (!options || !isAnthropicOAuthToken(options.apiKey))
				return provider.streamSimple(model, context, options);
			return provider.streamSimple(
				model,
				context,
				mergeClaudeCodeOptions(
					options,
					context,
					identity,
					latchedAtis(model.id),
				),
			);
		},
	};
}
