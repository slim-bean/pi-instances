# pi-instances — agent notes

Small pi package that tracks running pi instances and whether each agent is
**working** or **waiting for input**. See README.md for user-facing docs.

## Architecture

Cooperative, file-based registry — no daemon.

- `extensions/registry.ts` — the contract. `InstanceRecord` schema (versioned
  `v: 1`), the registry dir (`<PI_CONFIG_DIR|~/.pi>/instances/`), atomic
  `writeRecord`, `removeRecord`, `isAlive(pid)` (via `kill(pid, 0)`), and
  `listRecords()` which reaps files for dead pids.
- `extensions/index.ts` — the registrar. One `InstanceRecord` per process, kept
  in memory and flushed on every change plus a 5s heartbeat.
- `bin/pi-instances.mjs` — standalone viewer, **plain JS, zero deps** so it runs
  with bare `node`. It re-implements the tiny read/liveness logic rather than
  importing the TS module (keeps it toolchain-free). If you change the schema in
  `registry.ts`, update the viewer too. Modes: one-shot, `top` (alternate-screen
  dashboard with raw-key input), `-w` watch, `--json`.
  - `top` shows two sections: **LOCAL PI** (registry, `source !== "yono-attach"`)
    and **YONO ATTACH**.
  - `splitRecords()` separates local pi records from `source: "yono-attach"`
    records (written by the `yono attach` CLI — see the yono repo
    `cmd/yono/cmd/attach_status.go`). `yonoAttachRows()` merges those
    status-bearing records with `ps`-discovered attach processes, deduped by
    PID (registry record wins; `ps`-only shows `· att` with no status).
  - `listYonoAttach()` parses `ps -eo pid=,lstart=,args=` for local
    `yono attach` processes (tolerates global flags before `attach` and
    `--session`/`--shell` after). It's local-only by design — no cluster calls.
  - `runTop()` must always restore the terminal: cleanup runs on `q`/Ctrl+C/
    Ctrl+D, `SIGINT`/`SIGTERM`, and `process.on("exit")`, emitting
    `\x1b[?1049l\x1b[?25h` and clearing raw mode.
- `extensions/beacon.ts` — sandbox reporting. When `YONO_SANDBOX`/`SANDBOX_NAME`
  is set and stdout is a TTY, `flush()` also writes an OSC beacon
  (`ESC ] 6969 ; pi-status ; base64(JSON) BEL`) to stdout. yono's `sessiond`
  parses it (`cmd/yono/internal/sessiond/beacon.go`). **The beacon JSON field
  names are snake_case to match sessiond's `AgentStatus` struct tags** — keep
  the two in sync (there is a Go interop test pinning the exact wire bytes).

## Labels

- `label` (optional on `InstanceRecord`) is the human name shown in the viewer.
  Sourced from `PI_INSTANCE_LABEL` at `session_start` or the `/instances-label`
  command. `nameOf()` in the viewer prefers it over project/branch.
- `/instances-label` also mirrors the label into the pi session display name via
  `pi.setSessionName()` (empty string clears it), so it shows in the session
  selector as well. Best-effort, wrapped in try/catch.
- When a label is set, the extension pushes it to the terminal (pane) title via
  `ctx.ui.setTitle()` (never raw OSC — pi manages the title). `pushTitle()` is
  re-applied on every `flush()` so it survives pi's own periodic title updates.
  Per-pane by nature (each pane sets its own surface title); Ghostty shows the
  focused pane's. Opt out with `PI_INSTANCE_TITLE=0`.
- There is no way to read a Ghostty tab name into a process (no title-report
  query, not in env), so labels flow one way: we name the instance and push out.

## Sorting

- Both viewer sections sort via `compareRecords`: `status === "working"`
  instances are pinned to the top, then everything (working and non-working
  alike) falls back to `activityTime(r)` descending (most recent first), with
  `pid` as a stable tiebreaker so equal-activity rows never swap between polls.
- `activityTime(r)` is `lastActivityAt ?? startedAt` — it deliberately does NOT
  fall back to `updatedAt`, because the 5s heartbeat bumps `updatedAt` and that
  would make idle/waiting rows drift upward and jitter. A waiting row stays put
  (sorted by its last LLM response time) until it's interacted with again.
- `lastActivityAt` advances only on real activity: `setStatus` (agent_start,
  tool_execution_start, agent_end) and in-memory `markActive()` on
  `message_update` / `tool_execution_update` (persisted by the next heartbeat).
  It is deliberately NOT bumped by the plain heartbeat `flush()`, so idle
  instances sink over time.
- The beacon carries `last_activity_at`; the yono attach reporter copies it into
  yono-attach records so remote rows sort consistently.

## Invariants / gotchas

- Never start timers/watchers in the extension factory — pi forbids it. The
  heartbeat starts in `session_start`, stops in `session_shutdown`.
- Delete the record only on `session_shutdown` `reason: "quit"`. Reload/new/
  resume/fork keep the same process; the next `session_start` refreshes it.
- The `process.on("exit")` hook is a safety net for ungraceful exits. Hard kills
  (SIGKILL) skip it — the viewer's liveness reaping covers that case.
- The record `pid` is the pi process pid, which owns the heartbeat and exit hook.
- Keep the registry best-effort: writes are wrapped in try/catch so a broken
  registry never breaks the agent.

## Testing

No API key needed to exercise the lifecycle — `session_start` fires before any
LLM call:

```bash
# start pi with a held-open stdin so it stays at the prompt, then inspect
sleep 40 | script -q /dev/null pi -e extensions/index.ts &
node bin/pi-instances.mjs        # should show one waiting instance
```

Seed a fake record + a dead pid to test rendering and reaping:

```bash
mkdir -p ~/.pi/instances
echo '{"v":1,"pid":999999,"cwd":"/tmp","project":"dead","status":"waiting","startedAt":1,"updatedAt":1}' > ~/.pi/instances/999999.json
node bin/pi-instances.mjs   # 999999 is reaped (not alive)
```
