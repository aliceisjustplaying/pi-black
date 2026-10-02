import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import {
	type AnthropicRequestLogEntry,
	anthropicRequestLogPath,
} from "./claude-code-protocol.ts";

/** One hidden session message per Anthropic request, written as responses finish. */
export const REQUEST_MESSAGE_TYPE = "pi-black.anthropic-request";
/** The visible report a share command appends: every request id plus refusal details. */
export const REPORT_MESSAGE_TYPE = "pi-black.anthropic-report";

export const isPiBlackMessageType = (customType: unknown): boolean =>
	customType === REQUEST_MESSAGE_TYPE || customType === REPORT_MESSAGE_TYPE;

/** Claude Code's /feedback endpoint and its limits (claude-code 2.1.287: jpe, MQe). */
export const FEEDBACK_URL = "https://api.anthropic.com/api/claude_cli_feedback";
const MAX_FEEDBACK_BYTES = 8 * 1024 * 1024;
const MAX_RAW_TRANSCRIPT_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_RESULT_CHARS = 20_000;

// Minimal shapes of the session entries this module reads.
type Block = { type: string; [key: string]: unknown };
type SessionMessage = {
	role: string;
	content?: string | Block[];
	customType?: string;
	details?: unknown;
	responseId?: string;
	model?: string;
	stopReason?: string;
	rawStopReason?: string;
	errorMessage?: string;
	usage?: unknown;
	toolCallId?: string;
	isError?: boolean;
	timestamp?: number;
};
export type SessionEntry = {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp: string;
	message?: SessionMessage;
	customType?: string;
	details?: unknown;
	data?: unknown;
};

export const formatRequest = (entry: AnthropicRequestLogEntry): string => {
	const parts = [
		`request \`${entry.requestId ?? "none"}\``,
		`message \`${entry.messageId ?? "none"}\``,
		`HTTP ${entry.status}`,
		...(entry.stopReason ? [`stop \`${entry.stopReason}\``] : []),
		...(entry.model ? [entry.model] : []),
	];
	return parts.join(" · ");
};

const isProblem = (entry: AnthropicRequestLogEntry): boolean =>
	entry.stopReason === "refusal" ||
	entry.status >= 400 ||
	entry.error !== undefined ||
	entry.streamError !== undefined;


function readLoggedRequests(sessionId: string): AnthropicRequestLogEntry[] {
	const path = anthropicRequestLogPath();
	if (!path || !existsSync(path)) return [];
	const entries: AnthropicRequestLogEntry[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		if (!line.includes(sessionId)) continue;
		try {
			const entry = JSON.parse(line) as AnthropicRequestLogEntry;
			if (entry.sessionId === sessionId) entries.push(entry);
		} catch {
			// Skip a torn line.
		}
	}
	return entries;
}

/**
 * Every Anthropic request of the session, oldest first: the requests recorded in the
 * session (custom entries; hidden messages in earlier sessions), then the JSONL log (requests made before recording existed, or by another
 * process), keyed by Anthropic's request id. Assistant messages without either still
 * contribute Anthropic's message id.
 */
export function collectRequests(
	sessionId: string,
	entries: readonly SessionEntry[],
): AnthropicRequestLogEntry[] {
	const byKey = new Map<string, AnthropicRequestLogEntry>();
	const keyOf = (entry: AnthropicRequestLogEntry) =>
		entry.requestId ?? entry.messageId ?? entry.clientRequestId ?? entry.ts;
	const add = (entry: AnthropicRequestLogEntry) => {
		const key = keyOf(entry);
		byKey.set(key, { ...byKey.get(key), ...entry });
	};
	for (const entry of readLoggedRequests(sessionId)) add(entry);
	for (const entry of entries) {
		const message = entry.message;
		if (message?.role === "custom" && message.customType === REQUEST_MESSAGE_TYPE)
			add(message.details as AnthropicRequestLogEntry);
		else if (entry.type === "custom_message" && entry.customType === REQUEST_MESSAGE_TYPE)
			add(entry.details as AnthropicRequestLogEntry);
		else if (entry.type === "custom" && entry.customType === REQUEST_MESSAGE_TYPE)
			add(entry.data as AnthropicRequestLogEntry);
	}
	const known = new Set([...byKey.values()].map((entry) => entry.messageId));
	for (const entry of entries) {
		const message = entry.message;
		if (message?.role !== "assistant" || !message.responseId?.startsWith("msg_")) continue;
		if (known.has(message.responseId)) continue;
		add({
			ts: entry.timestamp,
			requestId: null,
			clientRequestId: null,
			sessionId,
			status: 200,
			messageId: message.responseId,
			...(message.model ? { model: message.model } : {}),
			...(message.rawStopReason ? { stopReason: message.rawStopReason } : {}),
		});
	}
	return [...byKey.values()].sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Pi's own error text for each Anthropic message id, which is what the user saw. */
function piErrorsByMessageId(entries: readonly SessionEntry[]): Map<string, string> {
	const errors = new Map<string, string>();
	for (const entry of entries) {
		const message = entry.message;
		if (message?.role === "assistant" && message.responseId && message.errorMessage)
			errors.set(message.responseId, message.errorMessage);
	}
	return errors;
}

export function buildReport(
	sessionId: string,
	requests: readonly AnthropicRequestLogEntry[],
	entries: readonly SessionEntry[],
): string {
	const problems = requests.filter(isProblem);
	const piErrors = piErrorsByMessageId(entries);
	const lines = [
		"## Anthropic request report",
		"",
		`Pi session \`${sessionId}\`. ${requests.length} Anthropic requests, ${problems.length} refused or failed. ` +
			"Request ids are Anthropic's `request-id` response header; message ids are the `id` Anthropic returned. " +
			"`clientRequestId` is pi-black's own `x-client-request-id`.",
	];
	if (problems.length > 0) {
		lines.push("", "### Refused or failed requests");
		for (const entry of problems) {
			const shown = entry.messageId ? piErrors.get(entry.messageId) : undefined;
			lines.push(
				"",
				`- ${entry.ts} · ${formatRequest(entry)}`,
				"",
				"```json",
				JSON.stringify({ ...entry, ...(shown ? { piErrorMessage: shown } : {}) }, null, 2),
				"```",
			);
		}
	}
	lines.push("", "### All requests", "", "| time | HTTP | request id | message id | stop |", "|---|---|---|---|---|");
	for (const entry of requests)
		lines.push(
			`| ${entry.ts} | ${entry.status} | ${entry.requestId ?? ""} | ${entry.messageId ?? ""} | ${entry.stopReason ?? entry.streamError ?? ""} |`,
		);
	return lines.join("\n");
}

const truncate = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max)}… [${text.length - max} characters cut]` : text;

const textOf = (content: SessionMessage["content"]): Block[] =>
	typeof content === "string"
		? [{ type: "text", text: content }]
		: (content ?? []).map((block) =>
				block.type === "image" ? { type: "text", text: "[image omitted]" } : block,
			);

/**
 * The session as Claude Code transcript rows (type, uuid, parentUuid, timestamp, sessionId,
 * message, requestId), with Anthropic's ids, raw stop reason, stop_details and usage from
 * the recorded requests. Images are replaced with a note.
 */
export function toClaudeCodeTranscript(
	sessionId: string,
	entries: readonly SessionEntry[],
	requests: readonly AnthropicRequestLogEntry[],
): Record<string, unknown>[] {
	const byMessageId = new Map(requests.filter((r) => r.messageId).map((r) => [r.messageId, r]));
	const rows: Record<string, unknown>[] = [];
	for (const entry of entries) {
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		const base = { uuid: entry.id, parentUuid: entry.parentId ?? null, timestamp: entry.timestamp, sessionId };
		if (message.role === "user") {
			rows.push({ ...base, type: "user", message: { role: "user", content: textOf(message.content) } });
		} else if (message.role === "toolResult") {
			const text = textOf(message.content)
				.map((block) => (typeof block.text === "string" ? block.text : ""))
				.join("\n");
			rows.push({
				...base,
				type: "user",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: message.toolCallId,
							content: truncate(text, MAX_TOOL_RESULT_CHARS),
							is_error: message.isError === true,
						},
					],
				},
			});
		} else if (message.role === "assistant") {
			const request = message.responseId ? byMessageId.get(message.responseId) : undefined;
			const content = (Array.isArray(message.content) ? message.content : []).map((block) =>
				block.type === "toolCall"
					? { type: "tool_use", id: block.id, name: block.name, input: block.arguments }
					: block.type === "thinking"
						? { type: "thinking", thinking: block.thinking }
						: block,
			);
			rows.push({
				...base,
				type: "assistant",
				requestId: request?.requestId ?? null,
				message: {
					id: message.responseId ?? null,
					type: "message",
					role: "assistant",
					model: request?.model ?? message.model,
					content,
					stop_reason: request?.stopReason ?? message.rawStopReason ?? message.stopReason,
					stop_details: request?.stopDetails ?? null,
					usage: request?.usage ?? message.usage,
				},
				...(message.errorMessage ? { piErrorMessage: message.errorMessage } : {}),
			});
		}
	}
	return rows;
}

function gitState(cwd: string): { gitRepo: boolean; commitSha: string | null } {
	try {
		const sha = execFileSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return { gitRepo: true, commitSha: sha || null };
	} catch {
		return { gitRepo: false, commitSha: null };
	}
}

/** The session file with image data removed, capped to the newest MAX_RAW_TRANSCRIPT_BYTES. */
function rawTranscript(sessionFile: string | undefined): string | undefined {
	if (!sessionFile || !existsSync(sessionFile)) return undefined;
	const stripped = readFileSync(sessionFile, "utf8").replace(
		/"data":"[A-Za-z0-9+/=]{200,}"/g,
		'"data":"[image omitted]"',
	);
	if (Buffer.byteLength(stripped) <= MAX_RAW_TRANSCRIPT_BYTES) return stripped;
	const tail = Buffer.from(stripped).subarray(-MAX_RAW_TRANSCRIPT_BYTES).toString("utf8");
	return tail.slice(tail.indexOf("\n") + 1);
}

export type FeedbackInput = {
	sessionId: string;
	sessionFile: string | undefined;
	cwd: string;
	entries: readonly SessionEntry[];
	description: string;
	piVersion: string;
};

/**
 * Claude Code's /feedback payload (claude-code 2.1.287 `xs`), labeled as coming from pi:
 * `surface` is "pi" and the description says so. `anthropicRequests` carries every recorded
 * request in full.
 */
export function buildFeedbackPayload(input: FeedbackInput): Record<string, unknown> {
	const requests = collectRequests(input.sessionId, input.entries);
	const transcript = toClaudeCodeTranscript(input.sessionId, input.entries, requests);
	const lastAssistant = [...transcript].reverse().find((row) => row.type === "assistant") as
		| { requestId: string | null; message: { id: string | null } }
		| undefined;
	const raw = rawTranscript(input.sessionFile);
	return {
		latestAssistantMessageId: lastAssistant?.requestId ?? null,
		latestAssistantAPIMessageId: lastAssistant?.message.id ?? null,
		lastInterruptedAssistantAPIMessageId: null,
		message_count: transcript.length,
		datetime: new Date().toISOString(),
		description: `[Sent from pi ${input.piVersion} via pi-black, not from Claude Code] ${input.description}`,
		surface: "pi",
		scope: "session",
		platform: process.platform,
		...gitState(input.cwd),
		terminal: process.env.TERM_PROGRAM ?? process.env.TERM ?? null,
		version: `pi ${input.piVersion}`,
		transcript,
		errors: requests
			.filter((entry) => entry.status >= 400 || entry.error || entry.streamError)
			.map((entry) => ({ error: JSON.stringify(entry), timestamp: entry.ts })),
		lastApiRequest: null,
		anthropicRequests: requests,
		...(raw ? { rawTranscriptJsonl: raw } : {}),
	};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The request body: Claude Code sends the payload as a JSON string under `content`.
 * Returns `undefined` when the payload is still over the cap after shrinking, which
 * is how Claude Code behaves (`payload_too_large_precheck`): it declines to submit
 * rather than sending an oversized body.
 */
export function feedbackBody(
	payload: Record<string, unknown>,
	sessionId: string,
): string | undefined {
	const outer = (inner: Record<string, unknown>) =>
		JSON.stringify({
			content: JSON.stringify(inner),
			...(UUID.test(sessionId) ? { session_id: sessionId } : {}),
		});
	// Shrink like Claude Code does when a payload is too large: drop the raw transcript,
	// then the transcript; the ids and request metadata always stay.
	let body = outer(payload);
	if (Buffer.byteLength(body) <= MAX_FEEDBACK_BYTES) return body;
	const { rawTranscriptJsonl: _, ...withoutRaw } = payload;
	body = outer(withoutRaw);
	if (Buffer.byteLength(body) <= MAX_FEEDBACK_BYTES) return body;
	body = outer({ ...withoutRaw, transcript: [] });
	// The remaining request records are what the report is for, so they are never
	// truncated; if they alone exceed the cap the submission is declined.
	return Buffer.byteLength(body) <= MAX_FEEDBACK_BYTES ? body : undefined;
}

export async function submitFeedback(
	body: string,
	accessToken: string,
	userAgent: string,
	signal?: AbortSignal,
): Promise<{ feedbackId: string } | { error: string }> {
	const response = await fetch(FEEDBACK_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"anthropic-beta": "oauth-2025-04-20",
			"Content-Type": "application/json",
			"User-Agent": userAgent,
		},
		body,
		signal,
	});
	const text = await response.text();
	let data: { feedback_id?: unknown } | undefined;
	try {
		data = JSON.parse(text);
	} catch {
		// Not JSON; reported below.
	}
	if (response.ok && typeof data?.feedback_id === "string") return { feedbackId: data.feedback_id };
	const requestId = response.headers.get("request-id");
	return {
		error: `HTTP ${response.status}${requestId ? ` (request ${requestId})` : ""}: ${text.slice(0, 500)}`,
	};
}
