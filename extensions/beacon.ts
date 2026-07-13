/**
 * Sandbox status beacon.
 *
 * When pi runs inside a yono sandbox, the local file registry (~/.pi/instances)
 * is invisible to your laptop. The one channel that already flows out of the
 * sandbox is pi's terminal (PTY) stream, which yono's `sessiond` captures.
 *
 * So we report status by writing a private OSC escape to stdout:
 *
 *   ESC ] 6969 ; pi-status ; <base64(JSON)> BEL
 *
 * Terminals ignore unknown OSC codes, so this is invisible in `yono attach`.
 * yono's sessiond harvests it (see cmd/yono/internal/sessiond/beacon.go) and
 * surfaces it as the sandbox's agent status. The JSON field names below must
 * match sessiond's AgentStatus struct tags.
 */

import type { InstanceRecord } from "./registry.ts";

/** yono sets these on the sandbox pod; pi inherits them via sessiond. */
export function sandboxName(): string | undefined {
	const candidates = [process.env.YONO_SANDBOX, process.env.SANDBOX_NAME, process.env.SANDBOX_ID];
	for (const value of candidates) {
		const trimmed = value?.trim();
		if (trimmed) return trimmed;
	}
	return undefined;
}

/** True when we should emit beacons: inside a sandbox and attached to a TTY. */
export function beaconEnabled(): boolean {
	return Boolean(sandboxName()) && Boolean(process.stdout.isTTY);
}

interface BeaconPayload {
	status: string;
	activity?: string;
	model?: string;
	session?: string;
	pid: number;
	updated_at: number;
	last_activity_at?: number;
	source: "pi";
}

/** Write one status beacon to stdout. Best-effort; never throws. */
export function emitBeacon(record: InstanceRecord): void {
	if (!beaconEnabled()) return;
	const payload: BeaconPayload = {
		status: record.status,
		activity: record.activity || undefined,
		model: record.model,
		session: record.session,
		pid: record.pid,
		updated_at: record.updatedAt,
		last_activity_at: record.lastActivityAt,
		source: "pi",
	};
	try {
		const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
		process.stdout.write(`\x1b]6969;pi-status;${encoded}\x07`);
	} catch {
		// Reporting is best-effort; never break the agent over it.
	}
}
