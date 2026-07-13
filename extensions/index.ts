/**
 * pi-instances — registrar extension.
 *
 * Each running pi instance reports its status to a small file registry
 * (~/.pi/instances/<pid>.json) so an out-of-process viewer can show which
 * agents are working vs. waiting for input. See registry.ts for the schema and
 * README.md for the viewer.
 *
 * Design notes:
 * - Background work (the heartbeat timer) is started in `session_start` and
 *   torn down in `session_shutdown`, per pi's extension guidance — never from
 *   the factory.
 * - The file is deleted only on `reason: "quit"`. For reload/new/resume/fork
 *   the same process keeps running and the following `session_start` refreshes
 *   the file, so we intentionally keep it.
 * - A `process.on("exit")` safety net unlinks the file if the process dies
 *   without emitting `session_shutdown`. The viewer also reaps stale files.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { beaconEnabled, emitBeacon, sandboxName } from "./beacon.ts";
import {
	detectGitBranch,
	type InstanceRecord,
	type InstanceStatus,
	projectLabel,
	removeRecord,
	writeRecord,
} from "./registry.ts";

const HEARTBEAT_MS = 5000;

// Pushing the label to the terminal (pane) title is on by default; each pane
// sets its own surface title, so Ghostty shows whichever pane is focused.
// Opt out with PI_INSTANCE_TITLE=0.
function titlePushEnabled(): boolean {
	const v = (process.env.PI_INSTANCE_TITLE ?? "").trim().toLowerCase();
	return v !== "0" && v !== "off" && v !== "false";
}

export default function (pi: ExtensionAPI) {
	const pid = process.pid;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let exitHookInstalled = false;
	// Latest ctx, captured at session_start, so the heartbeat and commands can
	// reach ctx.ui (setTitle) outside of an event handler.
	let latestCtx: ExtensionContext | undefined;

	// Mutable current state, flushed to disk on every change + heartbeat.
	const state: InstanceRecord = {
		v: 1,
		pid,
		cwd: process.cwd(),
		project: projectLabel(process.cwd()),
		status: "starting",
		startedAt: Date.now(),
		updatedAt: Date.now(),
	};

	const flush = () => {
		state.updatedAt = Date.now();
		try {
			writeRecord(state);
		} catch {
			// Registry is best-effort; never break the agent over it.
		}
		// In a sandbox, also beam status out over the PTY for yono to harvest.
		emitBeacon(state);
		// Keep the pane title showing the label. Re-applied on every flush so it
		// survives pi's own periodic title updates.
		pushTitle();
	};

	// Set the terminal (pane) surface title to the label via pi's title API
	// (raw OSC would be clobbered by pi's own title management). No-op when the
	// label is unset (leave pi's default title alone) or the push is disabled.
	const pushTitle = () => {
		if (!latestCtx?.hasUI || !titlePushEnabled()) return;
		if (!state.label) return;
		try {
			latestCtx.ui.setTitle(state.label);
		} catch {
			/* best-effort */
		}
	};

	const setStatus = (status: InstanceStatus, activity?: string) => {
		state.status = status;
		if (activity !== undefined) state.activity = activity;
		flush();
	};

	const startHeartbeat = () => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = setInterval(flush, HEARTBEAT_MS);
		// Don't keep the event loop alive just for the heartbeat.
		heartbeat.unref?.();
	};

	const stopHeartbeat = () => {
		if (heartbeat) clearInterval(heartbeat);
		heartbeat = undefined;
	};

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		latestCtx = ctx;
		const envLabel = (process.env.PI_INSTANCE_LABEL ?? "").trim();
		if (envLabel && !state.label) state.label = envLabel;
		state.cwd = ctx.cwd;
		state.project = projectLabel(ctx.cwd);
		state.git = detectGitBranch(ctx.cwd);
		state.sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
		state.model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
		if (beaconEnabled()) {
			// Label the project by sandbox name when running remotely.
			state.project = sandboxName() ?? state.project;
		}
		setStatus("waiting");
		startHeartbeat();

		if (!exitHookInstalled) {
			exitHookInstalled = true;
			process.on("exit", () => {
				try {
					removeRecord(pid);
				} catch {
					/* ignore */
				}
			});
		}
	});

	pi.on("session_info_changed", async (event) => {
		state.session = event.name ?? undefined;
		flush();
	});

	pi.on("model_select", async (event) => {
		state.model = `${event.model.provider}/${event.model.id}`;
		flush();
	});

	// Name this instance. The label shows as the primary name in the viewer and
	// (by default) is pushed to the terminal/pane title.
	//   /instances-label <name>   set the label
	//   /instances-label -        clear the label
	//   /instances-label          show the current label
	pi.registerCommand("instances-label", {
		description: "Set this pi instance's label (shown in pi-instances and the tab title)",
		handler: async (args, ctx) => {
			const text = args.trim();
			if (!text) {
				ctx.ui.notify(`Instance label: ${state.label ?? "(none)"}`, "info");
				return;
			}
			if (text === "-") {
				state.label = undefined;
				flush();
				// Revert the pane title to a sensible pi default.
				if (latestCtx?.hasUI && titlePushEnabled()) {
					const base = pi.getSessionName?.() || projectLabel(state.cwd);
					try {
						ctx.ui.setTitle(`π - ${base}`);
					} catch {
						/* best-effort */
					}
				}
				ctx.ui.notify("Instance label cleared", "info");
				return;
			}
			state.label = text;
			flush();
			ctx.ui.notify(`Instance label set: ${text}`, "info");
		},
	});

	pi.on("agent_start", async () => {
		setStatus("working", "");
	});

	pi.on("tool_execution_start", async (event) => {
		const arg = summarizeToolArgs(event.toolName, event.args);
		setStatus("working", arg ? `${event.toolName}: ${arg}` : event.toolName);
	});

	pi.on("agent_end", async () => {
		setStatus("waiting", "");
	});

	pi.on("session_shutdown", async (event) => {
		stopHeartbeat();
		if (event.reason === "quit") {
			removeRecord(pid);
		} else {
			// Same process continues; next session_start refreshes the record.
			setStatus("starting");
		}
	});

	// Convenience: list live instances from inside pi.
	pi.registerCommand("instances", {
		description: "List running pi instances and their status",
		handler: async (_args, ctx) => {
			const { listRecords } = await import("./registry.ts");
			const { records } = listRecords(true);
			if (records.length === 0) {
				ctx.ui.notify("No live pi instances found.", "info");
				return;
			}
			const lines = records
				.sort((a, b) => a.project.localeCompare(b.project))
				.map((r) => {
					const mark = r.status === "working" ? "●" : r.status === "waiting" ? "○" : "◌";
					const where = r.label ? r.label : r.git ? `${r.project} (${r.git})` : r.project;
					const act = r.activity ? ` — ${r.activity}` : "";
					const self = r.pid === pid ? " [this]" : "";
					return `${mark} ${r.status.padEnd(8)} ${where}${act}${self}`;
				});
			ctx.ui.notify(`Pi instances (${records.length}):\n${lines.join("\n")}`, "info");
		},
	});
}

/** Compact, single-line description of a tool's most useful argument. */
function summarizeToolArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	const pick = (key: string): string => (typeof a[key] === "string" ? (a[key] as string) : "");
	let value = "";
	switch (toolName) {
		case "bash":
			value = pick("command");
			break;
		case "read":
		case "write":
		case "edit":
			value = pick("path");
			break;
		default:
			value = pick("path") || pick("command") || pick("query") || pick("name");
	}
	value = value.replace(/\s+/g, " ").trim();
	return value.length > 60 ? `${value.slice(0, 57)}...` : value;
}
