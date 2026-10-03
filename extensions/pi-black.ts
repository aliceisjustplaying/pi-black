import { execFile, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	VERSION,
} from "@earendil-works/pi-coding-agent";
import {
	buildFeedbackPayload,
	buildReport,
	collectRequests,
	feedbackBody,
	isPiBlackMessageType,
	REPORT_MESSAGE_TYPE,
	REQUEST_MESSAGE_TYPE,
	type SessionEntry,
	submitFeedback,
} from "../src/anthropic-feedback.ts";
import { wrapAnthropicProvider } from "../src/anthropic-provider.ts";
import { exportShareHtml } from "../src/share-html.ts";
import {
	discoverClaudeCodeIdentity,
	onAnthropicRequestLogged,
} from "../src/claude-code-protocol.ts";
import {
	isSupportedPiVersion,
	MINIMUM_SUPPORTED_PI_VERSION,
} from "../src/compatibility.ts";

const run = promisify(execFile);

export default function piBlack(pi: ExtensionAPI): void {
	if (!isSupportedPiVersion(VERSION)) {
		throw new Error(
			`Pi Black requires Pi ${MINIMUM_SUPPORTED_PI_VERSION} or newer; running Pi is ${VERSION}`,
		);
	}
	const anthropic = builtinProviders().find(
		(provider) => provider.id === "anthropic",
	);
	if (!anthropic)
		throw new Error("Pi Black could not load Pi's built-in Anthropic provider");
	pi.registerProvider(
		wrapAnthropicProvider(anthropic, discoverClaudeCodeIdentity()),
	);
	registerAnthropicRequestRecording(pi);
}

/**
 * Records each Anthropic request of the session (Anthropic's request and message ids,
 * stop_details, usage, errors) as a custom session entry, and adds /share-ant-pi,
 * /share-ant-native and /share-msg-only for reporting a session to Anthropic.
 *
 * An entry, not a message: an entry is never model context, and it leaves the assistant's
 * reply as the run's last message. `pi --print` prints only when the last message is the
 * assistant's, so a message sent after the reply made it print nothing (exit 0).
 */
function registerAnthropicRequestRecording(pi: ExtensionAPI): void {
	let sessionId: string | undefined;
	let stopListening: (() => void) | undefined;

	pi.on("session_start", (_event, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		stopListening ??= onAnthropicRequestLogged((entry) => {
			if (!sessionId || entry.sessionId !== sessionId) return;
			pi.appendEntry(REQUEST_MESSAGE_TYPE, entry);
		});
	});
	pi.on("session_shutdown", () => {
		stopListening?.();
		stopListening = undefined;
		sessionId = undefined;
	});

	// Earlier sessions hold the requests as hidden messages, and a report is a message.
	pi.on("context", (event) => {
		const messages = event.messages.filter(
			(message) => !(message.role === "custom" && isPiBlackMessageType(message.customType)),
		);
		return messages.length === event.messages.length ? undefined : { messages };
	});

	const appendReport = (ctx: ExtensionCommandContext, extra = "") => {
		const id = ctx.sessionManager.getSessionId();
		const entries = ctx.sessionManager.getBranch() as unknown as SessionEntry[];
		const requests = collectRequests(id, entries);
		pi.sendMessage(
			{
				customType: REPORT_MESSAGE_TYPE,
				content: buildReport(id, requests, entries) + extra,
				display: true,
				details: { requests },
			},
			{ triggerTurn: false },
		);
		return requests;
	};

	pi.registerCommand("share-ant-pi", {
		description:
			"Share the session as a private gist, like /share, with a visible report of every Anthropic request id, message id and refusal",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const requests = appendReport(ctx);
			const sessionFile = ctx.sessionManager.getSessionFile();
			if (!sessionFile) {
				ctx.ui.notify("This session has no session file to share", "error");
				return;
			}
			const dir = mkdtempSync(join(tmpdir(), "pi-share-ant-"));
			try {
				const html = join(dir, "session.html");
				await exportShareHtml(pi, ctx, html);
				const { stdout } = await run("gh", ["gist", "create", "--public=false", html]);
				const gistUrl = stdout.trim();
				const gistId = gistUrl.split("/").pop();
				if (!gistId) throw new Error(`could not read the gist id from: ${stdout}`);
				const viewer = process.env.PI_SHARE_VIEWER_URL || "https://pi.dev/session/";
				ctx.ui.notify(
					`Share URL: ${viewer}#${gistId}\nGist: ${gistUrl}\n(${requests.length} Anthropic requests in the report)`,
					"info",
				);
			} catch (error) {
				ctx.ui.notify(`Share failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	});

	pi.registerCommand("share-msg-only", {
		description: "Copy the latest Anthropic message id and request id to the clipboard as msgid,requestid",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			const entries = ctx.sessionManager.getBranch() as unknown as SessionEntry[];
			const latest = collectRequests(ctx.sessionManager.getSessionId(), entries)
				.filter((entry) => entry.messageId || entry.requestId)
				.sort((a, b) => a.ts.localeCompare(b.ts))
				.at(-1);
			if (!latest) {
				ctx.ui.notify("No Anthropic request in this session yet", "error");
				return;
			}
			const text = `${latest.messageId ?? ""},${latest.requestId ?? ""}`;
			try {
				await new Promise<void>((resolve, reject) => {
					const child = spawn("pbcopy");
					child.on("error", reject);
					child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pbcopy exited ${code}`))));
					child.stdin.end(text);
				});
				ctx.ui.notify(`Copied: ${text}`, "info");
			} catch (error) {
				ctx.ui.notify(`Copy failed (${error instanceof Error ? error.message : String(error)}): ${text}`, "error");
			}
		},
	});

	pi.registerCommand("share-ant-native", {
		description:
			"Send the session to Anthropic's Claude Code /feedback endpoint, labeled as pi, with every request id, message id and refusal",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();
			const description =
				args.trim() || (await ctx.ui.input("What went wrong?", "e.g. false-positive refusal"))?.trim();
			if (!description) {
				ctx.ui.notify("Cancelled: a description is required", "warning");
				return;
			}
			const id = ctx.sessionManager.getSessionId();
			const payload = buildFeedbackPayload({
				sessionId: id,
				sessionFile: ctx.sessionManager.getSessionFile(),
				cwd: ctx.cwd,
				entries: ctx.sessionManager.getBranch() as unknown as SessionEntry[],
				description,
				piVersion: VERSION,
			});
			const body = feedbackBody(payload, id);
			if (body === undefined) {
				ctx.ui.notify(
					"Feedback payload is too large to send even after dropping the transcript. " +
						"Share a narrower session, or report without the transcript.",
					"error",
				);
				return;
			}
			const requests = (payload.anthropicRequests as unknown[]).length;
			const ok = await ctx.ui.confirm(
				"Send to Anthropic?",
				`This sends the session transcript (${Math.round(Buffer.byteLength(body) / 1024)} KB, ${requests} request ids) to ` +
					"Anthropic's Claude Code feedback endpoint, where feedback transcripts are kept for 5 years.",
			);
			if (!ok) return;
			const token = await ctx.modelRegistry.getApiKeyForProvider("anthropic");
			if (!token?.includes("sk-ant-oat")) {
				ctx.ui.notify("The feedback endpoint needs Anthropic OAuth (a Claude subscription login)", "error");
				return;
			}
			const result = await submitFeedback(body, token, `pi-black (pi ${VERSION})`);
			if ("error" in result) {
				ctx.ui.notify(`Feedback failed: ${result.error}`, "error");
				return;
			}
			appendReport(ctx, `\n\nSent to Anthropic as feedback \`${result.feedbackId}\`.`);
			ctx.ui.notify(`Sent to Anthropic: feedback id ${result.feedbackId}`, "info");
		},
	});
}
