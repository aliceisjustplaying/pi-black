import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	getPackageDir,
} from "@earendil-works/pi-coding-agent";
import { collectRequests, type SessionEntry } from "./anthropic-feedback.ts";
import type { AnthropicRequestLogEntry } from "./claude-code-protocol.ts";

/** The ids shown under one assistant message in the shared HTML. */
type MessageIds = {
	requestId: string | null;
	messageId: string | null;
	stopReason?: string;
};

type AssistantMessage = NonNullable<SessionEntry["message"]> & {
	api?: string;
	provider?: string;
};

/**
 * A logged request that plausibly caused an error. A request that succeeded
 * must never be attached to one: annotating a failed message with an HTTP 200
 * from an earlier turn is worse than leaving it blank.
 */
function isFailedRequest(request: AnthropicRequestLogEntry): boolean {
	return (
		request.stopReason === "refusal" ||
		request.status >= 400 ||
		request.error !== undefined ||
		request.streamError !== undefined
	);
}

/**
 * Only Anthropic requests are logged, so an assistant from another provider must
 * not borrow one. Provenance is optional in older sessions; when it is unknown we
 * fall through to the timestamp and failure checks rather than assuming.
 */
function isForeignAssistant(message: AssistantMessage): boolean {
	if (message.provider !== undefined) return message.provider !== "anthropic";
	if (message.api !== undefined) return message.api !== "anthropic-messages";
	return false;
}

function toMillis(value: string | undefined): number {
	if (!value) return Number.NEGATIVE_INFINITY;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

/**
 * Anthropic's ids for each assistant message entry. Messages match their request by
 * Anthropic's message id. A failed response has no message id, so each failed Anthropic
 * assistant takes the latest unused failed request logged during its own turn.
 */
export function idsByEntry(
	entries: readonly SessionEntry[],
	requests: readonly AnthropicRequestLogEntry[],
): Record<string, MessageIds> {
	const byMessageId = new Map(
		requests.filter((r) => r.messageId).map((r) => [r.messageId, r]),
	);
	const used = new Set<AnthropicRequestLogEntry>();
	const result: Record<string, MessageIds> = {};
	const assistants = entries.filter((e) => e.message?.role === "assistant");
	for (const entry of assistants) {
		const message = entry.message as AssistantMessage;
		if (isForeignAssistant(message)) continue;
		const request = message.responseId ? byMessageId.get(message.responseId) : undefined;
		if (request) used.add(request);
		if (request || message.responseId?.startsWith("msg_"))
			result[entry.id] = {
				requestId: request?.requestId ?? null,
				messageId: message.responseId ?? null,
				stopReason: request?.stopReason ?? message.rawStopReason,
			};
	}
	for (const [index, entry] of entries.entries()) {
		const message = entry.message as AssistantMessage | undefined;
		if (!message || message.role !== "assistant") continue;
		if (result[entry.id] || message.stopReason !== "error") continue;
		if (isForeignAssistant(message)) continue;
		// Stay inside this turn: a request belongs to this assistant only if it was
		// logged after the previous entry, so an abandoned branch or an earlier
		// turn's failure cannot be adopted.
		const floor = toMillis(entries[index - 1]?.timestamp);
		const request = requests
			.filter(
				(candidate) =>
					!used.has(candidate) &&
					!candidate.messageId &&
					isFailedRequest(candidate) &&
					toMillis(candidate.ts) > floor &&
					toMillis(candidate.ts) <= toMillis(entry.timestamp),
			)
			.at(-1);
		if (!request) continue;
		used.add(request);
		result[entry.id] = {
			requestId: request.requestId,
			messageId: null,
			stopReason:
				request.stopReason ??
				request.streamError ??
				(request.status >= 400 ? `HTTP ${request.status}` : undefined),
		};
	}
	return result;
}

/**
 * A script for pi's HTML export that adds Anthropic's ids under each assistant message.
 * The template re-renders entries when navigating the tree, so it watches the DOM.
 */
function idsScript(ids: Record<string, MessageIds>): string {
	// Escape "<" so session text cannot close the script element.
	const data = JSON.stringify(ids).replace(/</g, "\\u003c");
	return `<style>
.ant-ids { margin-top: 6px; font-size: 11px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.ant-ids code { user-select: all; }
.ant-ids .refusal { color: var(--error); }
</style>
<script>
(() => {
  const ids = ${data};
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const tag = (el) => {
    if (!el.id.startsWith("entry-") || el.querySelector(":scope > .ant-ids")) return;
    const info = ids[el.id.slice(6)];
    if (!info) return;
    const parts = [
      "request <code>" + esc(info.requestId ?? "none") + "</code>",
      "message <code>" + esc(info.messageId ?? "none") + "</code>",
    ];
    if (info.stopReason) parts.push('<span class="' + (info.stopReason === "refusal" ? "refusal" : "") + '">stop ' + esc(info.stopReason) + "</span>");
    const div = document.createElement("div");
    div.className = "ant-ids";
    div.innerHTML = parts.join(" · ");
    el.appendChild(div);
  };
  const scan = (root) => root.querySelectorAll?.(".assistant-message[id]").forEach(tag);
  new MutationObserver((records) => {
    for (const record of records) for (const node of record.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches(".assistant-message[id]")) tag(node);
      scan(node);
    }
  }).observe(document.body, { childList: true, subtree: true });
  scan(document);
})();
</script>`;
}

type ExportHtmlModule = {
	exportSessionToHtml(
		sessionManager: ExtensionCommandContext["sessionManager"],
		state: { systemPrompt: string; tools: { name: string; description: string; parameters: unknown }[] },
		options: { outputPath: string; themeName?: string },
	): Promise<string>;
};

/**
 * Writes the session as the same HTML pi's /share uploads (pi's own exporter, current
 * theme, system prompt and active tools), plus Anthropic's ids under each assistant message.
 * Custom tools render without their TUI renderers, which extensions cannot reach.
 */
export async function exportShareHtml(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	outputPath: string,
): Promise<void> {
	const modulePath = join(getPackageDir(), "dist", "core", "export-html", "index.js");
	const { exportSessionToHtml } = (await import(pathToFileURL(modulePath).href)) as ExportHtmlModule;
	const active = new Set(pi.getActiveTools());
	const tools = pi
		.getAllTools()
		.filter((tool) => active.has(tool.name))
		.map(({ name, description, parameters }) => ({ name, description, parameters }));
	await exportSessionToHtml(
		ctx.sessionManager,
		{ systemPrompt: ctx.getSystemPrompt(), tools },
		{ outputPath, themeName: ctx.ui.theme.name },
	);
	const entries = ctx.sessionManager.getEntries() as unknown as SessionEntry[];
	const requests = collectRequests(ctx.sessionManager.getSessionId(), entries);
	const html = readFileSync(outputPath, "utf8");
	const at = html.lastIndexOf("</body>");
	if (at < 0) throw new Error("pi's HTML export has no </body>");
	writeFileSync(outputPath, html.slice(0, at) + idsScript(idsByEntry(entries, requests)) + html.slice(at));
}
