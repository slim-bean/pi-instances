#!/usr/bin/env node
/**
 * pi-instances — live viewer for running pi instances.
 *
 * Reads the file registry written by the registrar extension
 * (~/.pi/instances/<pid>.json), verifies each pid is still alive, reaps dead
 * entries, and prints a status table. Zero dependencies — Node built-ins only.
 *
 * Usage:
 *   pi-instances            One-shot snapshot.
 *   pi-instances top        Full-screen "top"-style live dashboard.
 *   pi-instances -w [secs]  Watch mode, refresh every N seconds (default 2).
 *   pi-instances --json     Machine-readable JSON snapshot.
 *   pi-instances -h         Help.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const C = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	red: "\x1b[31m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	gray: "\x1b[90m",
};
const useColor = process.stdout.isTTY;
const c = (code, s) => (useColor ? `${code}${s}${C.reset}` : s);

function instancesDir() {
	const configDir = (process.env.PI_CONFIG_DIR || "").trim() || join(homedir(), ".pi");
	return join(configDir, "instances");
}

function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return err.code === "EPERM";
	}
}

function listRecords() {
	const dir = instancesDir();
	const records = [];
	let files = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
	} catch {
		return records;
	}
	for (const file of files) {
		const full = join(dir, file);
		let rec;
		try {
			rec = JSON.parse(readFileSync(full, "utf8"));
		} catch {
			rec = undefined;
		}
		const pid = rec?.pid ?? Number.parseInt(basename(file, ".json"), 10);
		if (!Number.isFinite(pid)) continue;
		if (!isAlive(pid)) {
			rmSync(full, { force: true });
			continue;
		}
		if (rec) records.push(rec);
	}
	return records;
}

// Split registry records into local pi instances vs. yono-attach mirrors.
function splitRecords(records) {
	const pi = [];
	const attach = [];
	for (const r of records) {
		if (r.source === "yono-attach") attach.push(r);
		else pi.push(r);
	}
	return { pi, attach };
}

// Merge yono-attach registry records (which carry live status) with any
// `yono attach` processes found via ps that don't yet have a record (e.g. an
// older yono CLI, a shell session, or a just-started attach). Registry records
// win; ps-only entries appear without status.
function yonoAttachRows() {
	const { attach } = splitRecords(listRecords());
	const byPid = new Map();
	const rows = [];
	for (const r of attach) {
		byPid.set(r.pid, true);
		rows.push({
			pid: r.pid,
			sandbox: r.sandbox || r.project || "?",
			session: r.session || "agent",
			startedAt: r.startedAt,
			updatedAt: r.updatedAt,
			lastActivityAt: r.lastActivityAt,
			status: r.status,
			activity: r.activity,
			model: r.model,
		});
	}
	for (const p of listYonoAttach()) {
		if (byPid.has(p.pid)) continue;
		rows.push({ ...p, status: null });
	}
	return rows.sort(compareRecords);
}

function fmtAge(ms) {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h${m % 60}m`;
	return `${Math.floor(h / 24)}d${h % 24}h`;
}

const STALE_MS = 20000; // heartbeat is 5s; flag if we haven't heard in a while.

function statusCell(rec) {
	const stale = Date.now() - (rec.updatedAt ?? 0) > STALE_MS;
	if (stale) return c(C.red, "stale?  ");
	switch (rec.status) {
		case "working":
			return c(C.yellow, "● work  ");
		case "waiting":
			return c(C.green, "○ wait  ");
		default:
			return c(C.gray, "◌ start ");
	}
}

// Time of last genuine activity, most-recent-first sort key. Deliberately does
// NOT fall back to `updatedAt` (the heartbeat bumps it every 5s, which would
// make idle rows drift upward and the order jitter). Falls back to the fixed
// start time so a waiting row stays put until it's interacted with again.
function activityTime(r) {
	return r.lastActivityAt ?? r.startedAt ?? 0;
}

// Display sort: any instance actively working sorts above everything else, then
// the rest fall back to most-recent-activity order. This keeps busy agents
// pinned to the top regardless of how long they've been running. `pid` is a
// stable tiebreaker so equal-activity rows never swap places between polls.
function compareRecords(a, b) {
	const aw = a.status === "working" ? 1 : 0;
	const bw = b.status === "working" ? 1 : 0;
	if (aw !== bw) return bw - aw;
	const dt = activityTime(b) - activityTime(a);
	if (dt !== 0) return dt;
	return (a.pid ?? 0) - (b.pid ?? 0);
}

// Primary display name for a local pi record: explicit label wins, else the
// project (with git branch when known).
function nameOf(r) {
	if (r.label) return r.label;
	return r.git ? `${r.project} (${r.git})` : r.project;
}

function pad(s, n) {
	// Pad ignoring ANSI escape width.
	const bare = s.replace(/\x1b\[[0-9;]*m/g, "");
	const extra = s.length - bare.length;
	return bare.length >= n ? s : s + " ".repeat(n - bare.length);
}

function render() {
	const records = splitRecords(listRecords()).pi.sort(compareRecords);

	const lines = [];
	const stamp = new Date().toLocaleTimeString();
	const working = records.filter((r) => r.status === "working").length;
	const waiting = records.filter((r) => r.status === "waiting").length;
	lines.push(
		c(C.bold, `pi instances`) +
			c(C.dim, `  ${records.length} live · `) +
			c(C.yellow, `${working} working`) +
			c(C.dim, " · ") +
			c(C.green, `${waiting} waiting`) +
			c(C.dim, `   ${stamp}`),
	);
	lines.push("");

	if (records.length === 0) {
		lines.push(c(C.dim, "  (no running pi instances)"));
		return lines.join("\n");
	}

	lines.push(
		c(C.dim, pad("STATUS", 9) + pad("PID", 8) + pad("PROJECT", 40) + pad("LAST ACTIVE", 13) + "ACTIVITY / MODEL"),
	);
	for (const r of records) {
		const where = nameOf(r);
		const detail = r.activity
			? r.activity
			: c(C.dim, r.model || "");
		lines.push(
			pad(statusCell(r), 9) +
				pad(c(C.gray, String(r.pid)), 8) +
				pad(c(C.cyan, where.slice(0, 39)), 40) +
				pad(c(C.dim, fmtAge(activityTime(r))), 13) +
				detail,
		);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// yono attach sessions (local processes connected to remote sandboxes)
// ---------------------------------------------------------------------------

// listYonoAttach enumerates local `yono attach` processes via ps. These are
// the sessions you have open into remote sandboxes; their per-agent status
// lives in yono (dashboard / `yono describe sandbox`), not locally, so here we
// just show that the connection is up and to which sandbox.
function listYonoAttach() {
	const res = spawnSync("ps", ["-eo", "pid=,lstart=,args="], { encoding: "utf8" });
	if (res.status !== 0 || !res.stdout) return [];
	const out = [];
	for (const raw of res.stdout.split("\n")) {
		const line = raw.trim();
		if (!line) continue;
		// pid | lstart (Day Mon DD HH:MM:SS YYYY) | args
		const m = line.match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/);
		if (!m) continue;
		const [, pid, lstart, args] = m;
		if (!/\byono\b/.test(args) || !/\battach\b/.test(args)) continue;
		if (/[/ ]ps\b/.test(args)) continue; // skip our own ps line
		const parsed = parseYonoAttachArgs(args);
		if (!parsed) continue;
		const started = Date.parse(lstart);
		out.push({ pid: Number(pid), startedAt: Number.isFinite(started) ? started : Date.now(), ...parsed });
	}
	return out.sort((a, b) => (a.sandbox || "").localeCompare(b.sandbox || ""));
}

// parseYonoAttachArgs extracts the sandbox name and session from a `yono attach`
// command line, tolerating global flags before `attach` and flags after it.
function parseYonoAttachArgs(args) {
	const tokens = args.split(/\s+/);
	const ai = tokens.indexOf("attach");
	if (ai < 0) return null;
	const positional = [];
	let session = "";
	let shell = false;
	for (let i = ai + 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t === "--shell") {
			shell = true;
			continue;
		}
		if (t === "--session" || t === "-s") {
			session = tokens[++i] || "";
			continue;
		}
		const kv = t.match(/^--session=(.*)$/);
		if (kv) {
			session = kv[1];
			continue;
		}
		if (t.startsWith("-")) continue; // other flag: skip
		positional.push(t);
	}
	// positional: [kind, name]; kind is sandbox|sb.
	const name = positional[1] || positional[0] || "";
	if (!name) return null;
	return { sandbox: name, session: shell ? "shell" : session || "agent" };
}

// ---------------------------------------------------------------------------
// "top"-style full-screen dashboard
// ---------------------------------------------------------------------------

function renderTop(width) {
	const w = width || 80;
	const records = splitRecords(listRecords()).pi.sort(compareRecords);
	const attach = yonoAttachRows();

	const working = records.filter((r) => r.status === "working").length;
	const waiting = records.filter((r) => r.status === "waiting").length;
	const rule = c(C.gray, "─".repeat(w));
	const lines = [];

	lines.push(
		c(C.bold, " pi-instances") +
			c(C.dim, `  ${records.length} pi · `) +
			c(C.yellow, `${working} working`) +
			c(C.dim, " · ") +
			c(C.green, `${waiting} waiting`) +
			c(C.dim, ` · ${attach.length} yono attach`) +
			c(C.dim, `    ${new Date().toLocaleTimeString()}`),
	);
	lines.push(rule);

	lines.push(c(C.bold, " LOCAL PI"));
	if (records.length === 0) {
		lines.push(c(C.dim, "   (none)"));
	} else {
		lines.push(c(C.dim, " " + pad("STATUS", 9) + pad("PID", 8) + pad("PROJECT", 34) + pad("LAST ACTIVE", 13) + "ACTIVITY / MODEL"));
		for (const r of records) {
			const where = nameOf(r);
			const detail = r.activity ? r.activity : c(C.dim, r.model || "");
			lines.push(
				" " +
					pad(statusCell(r), 9) +
					pad(c(C.gray, String(r.pid)), 8) +
					pad(c(C.cyan, where.slice(0, 33)), 34) +
					pad(c(C.dim, fmtAge(activityTime(r))), 13) +
					detail,
			);
		}
	}

	lines.push("");
	lines.push(c(C.bold, ` YONO ATTACH${attach.length ? ` (${attach.length})` : ""}`));
	if (attach.length === 0) {
		lines.push(c(C.dim, "   (none)"));
	} else {
		lines.push(
			c(C.dim, " " + pad("STATUS", 9) + pad("PID", 8) + pad("SANDBOX", 24) + pad("SESSION", 9) + pad("LAST ACTIVE", 13) + "ACTIVITY / MODEL"),
		);
		for (const a of attach) {
			const statusStr = a.status
				? statusCell({ status: a.status, updatedAt: a.updatedAt })
				: c(C.dim, "· att   ");
			const detail = a.activity ? a.activity : c(C.dim, a.model || "");
			lines.push(
				" " +
					pad(statusStr, 9) +
					pad(c(C.gray, String(a.pid)), 8) +
					pad(c(C.cyan, (a.sandbox || "?").slice(0, 23)), 24) +
					pad(a.session === "shell" ? c(C.dim, "shell") : "agent", 9) +
					pad(c(C.dim, fmtAge(activityTime(a))), 13) +
					detail,
			);
		}
	}

	lines.push("");
	lines.push(rule);
	lines.push(c(C.dim, " q quit · r refresh"));
	return lines.join("\n");
}

function runTop(interval) {
	const enter = () => process.stdout.write("\x1b[?1049h\x1b[?25l"); // alt screen, hide cursor
	const leave = () => process.stdout.write("\x1b[?1049l\x1b[?25h"); // restore
	let timer;
	let done = false;
	const cleanup = () => {
		if (done) return;
		done = true;
		clearInterval(timer);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdin.pause();
		leave();
	};
	const draw = () => {
		const w = process.stdout.columns || 80;
		process.stdout.write("\x1b[H\x1b[2J" + renderTop(w));
	};

	enter();
	draw();
	timer = setInterval(draw, interval);

	if (process.stdin.isTTY) process.stdin.setRawMode(true);
	process.stdin.resume();
	process.stdin.on("data", (buf) => {
		const key = buf.toString();
		if (key === "q" || key === "\x03" || key === "\x04") {
			cleanup();
			process.exit(0);
		} else if (key === "r") {
			draw();
		}
	});
	process.stdout.on("resize", draw);
	process.on("SIGINT", () => {
		cleanup();
		process.exit(0);
	});
	process.on("SIGTERM", () => {
		cleanup();
		process.exit(0);
	});
	process.on("exit", cleanup);
}

function main() {
	const args = process.argv.slice(2);
	if (args.includes("-h") || args.includes("--help")) {
		console.log(
			[
				"pi-instances — show running pi instances and their status",
				"",
				"Usage:",
				"  pi-instances            One-shot snapshot",
				"  pi-instances top        Full-screen 'top'-style dashboard",
				"  pi-instances -w [secs]  Watch mode (default 2s refresh)",
				"  pi-instances --json     JSON snapshot",
			].join("\n"),
		);
		return;
	}
	if (args.includes("--json")) {
		console.log(JSON.stringify({ pi: splitRecords(listRecords()).pi, yonoAttach: yonoAttachRows() }, null, 2));
		return;
	}
	if (args[0] === "top") {
		const secs = Number.parseFloat(args[1]);
		const interval = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 1000;
		runTop(interval);
		return;
	}
	const watch = args.includes("-w") || args.includes("--watch");
	if (!watch) {
		console.log(render());
		return;
	}
	const idx = Math.max(args.indexOf("-w"), args.indexOf("--watch"));
	const secs = Number.parseFloat(args[idx + 1]);
	const interval = Number.isFinite(secs) && secs > 0 ? secs * 1000 : 2000;

	const draw = () => {
		process.stdout.write("\x1b[2J\x1b[H"); // clear + home
		process.stdout.write(render() + "\n");
		process.stdout.write(c(C.dim, "\n(Ctrl+C to quit)\n"));
	};
	draw();
	const timer = setInterval(draw, interval);
	process.on("SIGINT", () => {
		clearInterval(timer);
		process.stdout.write("\n");
		process.exit(0);
	});
}

main();
