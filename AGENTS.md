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
