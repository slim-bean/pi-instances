/**
 * Shared status-registry helpers for the pi-instances tracker.
 *
 * Each running pi instance owns exactly one status file:
 *   ~/.pi/instances/<pid>.json
 *
 * The registrar extension (index.ts) writes/updates these files on lifecycle
 * events; the standalone viewer (bin/pi-instances.mjs) reads them, verifies
 * liveness, and reaps dead entries. The JSON schema is intentionally small and
 * stable so both sides can evolve independently.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type InstanceStatus = "starting" | "working" | "waiting";

export interface InstanceRecord {
	/** Schema version, so the viewer can detect incompatibilities. */
	v: 1;
	pid: number;
	cwd: string;
	/** Human label: git worktree/branch when available, else the last cwd segments. */
	project: string;
	git?: string;
	session?: string;
	sessionFile?: string;
	model?: string;
	status: InstanceStatus;
	/** Short description of what the agent is doing (e.g. "bash: make test"). */
	activity?: string;
	startedAt: number;
	updatedAt: number;
}

/** Root directory holding one JSON file per live pi instance. */
export function instancesDir(): string {
	const configDir = process.env.PI_CONFIG_DIR?.trim() || join(homedir(), ".pi");
	return join(configDir, "instances");
}

function recordPath(pid: number): string {
	return join(instancesDir(), `${pid}.json`);
}

/** Best-effort git branch for a cwd (single cheap call, used once per session). */
export function detectGitBranch(cwd: string): string | undefined {
	try {
		const out = spawnSync("git", ["-C", cwd, "branch", "--show-current"], {
			encoding: "utf8",
			timeout: 1500,
		});
		const branch = out.stdout?.trim();
		return branch || undefined;
	} catch {
		return undefined;
	}
}

/** A readable project label from a cwd (last two path segments). */
export function projectLabel(cwd: string): string {
	const parent = basename(dirname(cwd));
	const leaf = basename(cwd);
	return parent && parent !== "." ? `${parent}/${leaf}` : leaf;
}

export function writeRecord(record: InstanceRecord): void {
	const dir = instancesDir();
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const tmp = `${recordPath(record.pid)}.tmp`;
	writeFileSync(tmp, JSON.stringify(record));
	// Atomic replace so the viewer never reads a half-written file.
	rmSync(recordPath(record.pid), { force: true });
	writeFileSync(recordPath(record.pid), readFileSync(tmp));
	rmSync(tmp, { force: true });
}

export function removeRecord(pid: number): void {
	rmSync(recordPath(pid), { force: true });
}

/** True if a process with this pid is currently alive (owned or not). */
export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: process exists but we can't signal it — still alive.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export interface ListResult {
	records: InstanceRecord[];
	/** pids whose files were removed because the process is gone. */
	reaped: number[];
}

/** Read all records, optionally reaping files for dead processes. */
export function listRecords(reap = true): ListResult {
	const dir = instancesDir();
	const records: InstanceRecord[] = [];
	const reaped: number[] = [];
	let files: string[] = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".json"));
	} catch {
		return { records, reaped };
	}
	for (const file of files) {
		const full = join(dir, file);
		let rec: InstanceRecord | undefined;
		try {
			rec = JSON.parse(readFileSync(full, "utf8")) as InstanceRecord;
		} catch {
			rec = undefined;
		}
		const pid = rec?.pid ?? Number.parseInt(basename(file, ".json"), 10);
		if (!Number.isFinite(pid)) continue;
		if (!isAlive(pid)) {
			if (reap) {
				rmSync(full, { force: true });
				reaped.push(pid);
			}
			continue;
		}
		if (rec) records.push(rec);
	}
	return { records, reaped };
}
