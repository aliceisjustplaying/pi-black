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

/**
 * Anthropic's ids for each assistant message entry. Messages match their request by
 * Anthropic's message id. A failed response has no message id, so each failed assistant
 * message takes the latest unmatched request logged at or before it.
 */
function idsByEntry(
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
		const message = entry.message!;
		const request = message.responseId ? byMessageId.get(message.responseId) : undefined;
		if (request) used.add(request);
		if (request || message.responseId?.startsWith("msg_"))
			result[entry.id] = {
				requestId: request?.requestId ?? null,
				messageId: message.responseId ?? null,
				stopReason: request?.stopReason ?? message.rawStopReason,
			};
	}
	for (const entry of assistants) {
		const message = entry.message!;
		if (result[entry.id] || message.stopReason !== "error") continue;
		const request = requests
			.filter((r) => !used.has(r) && !r.messageId && r.ts <= entry.timestamp)
			.at(-1);
		if (!request) continue;
		used.add(request);
		result[entry.id] = {
			requestId: request.requestId,
			messageId: null,
			stopReason: request.stopReason ?? request.streamError ?? `HTTP ${request.status}`,
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
.pi-black-ids { margin-top: 6px; font-size: 11px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.pi-black-ids code { user-select: all; }
.pi-black-ids .refusal { color: var(--error); }
</style>
<script>
(() => {
  const ids = ${data};
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const tag = (el) => {
    if (!el.id.startsWith("entry-") || el.querySelector(":scope > .pi-black-ids")) return;
    const info = ids[el.id.slice(6)];
    if (!info) return;
    const parts = [
      "request <code>" + esc(info.requestId ?? "none") + "</code>",
      "message <code>" + esc(info.messageId ?? "none") + "</code>",
    ];
    if (info.stopReason) parts.push('<span class="' + (info.stopReason === "refusal" ? "refusal" : "") + '">stop ' + esc(info.stopReason) + "</span>");
    const div = document.createElement("div");
    div.className = "pi-black-ids";
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
