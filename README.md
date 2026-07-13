# pi-instances

Track running [pi](https://github.com/earendil-works/pi) instances and see, at a
glance, which agents are **working** and which are **waiting for your input**.

Every pi instance loads a small registrar extension that reports its status to a
file registry. A dependency-free viewer reads that registry and prints a live
table. No server, no sockets — just one JSON file per instance.

## How it works

```
pi instance A ─┐
pi instance B ─┼─►  ~/.pi/instances/<pid>.json  ◄── pi-instances viewer (reads)
pi instance C ─┘        (one file each)
```

- The **registrar extension** (`extensions/index.ts`) writes `~/.pi/instances/<pid>.json`
  on `session_start` and updates it on lifecycle events:
  - `agent_start` → `working`
  - `tool_execution_start` → `working`, with the current tool as the activity
  - `agent_end` → `waiting` (waiting for your input)
  - a 5s heartbeat keeps `updatedAt` fresh
  - `session_shutdown(quit)` (and a `process.exit` safety net) removes the file
- The **viewer** (`bin/pi-instances.mjs`) lists live instances, verifies each pid
  with `kill(pid, 0)`, and **reaps** files whose process has died (e.g. a crash
  that skipped cleanup). Instances that go quiet for >20s are flagged `stale?`.

Because it is cooperative (each pi reports its own state) it can show
working-vs-waiting, which sniffing `ps` alone cannot.

## Install

Install globally (loads in every pi instance) straight from git:

```bash
pi install git:github.com/slim-bean/pi-instances
# pin a release for reproducibility:
pi install git:github.com/slim-bean/pi-instances@v0.1.0
```

Try it for one run without installing:

```bash
pi -e git:github.com/slim-bean/pi-instances
```

Or point at a local checkout via `~/.pi/agent/settings.json`:

```jsonc
{
  "packages": [
    "../../projects/pi-instances"   // relative to ~/.pi/agent → ~/projects/pi-instances
  ]
}
```

Reload pi (or `/reload`) and every instance starts reporting.

> **Viewer CLI note:** `pi install` loads the *extension*; it does not put the
> `pi-instances` viewer binary on your `PATH`. Run the viewer from the clone,
> e.g. `node ~/.pi/agent/git/github.com/slim-bean/pi-instances/bin/pi-instances.mjs top`,
> or from a local checkout, and alias it (see below).

## The viewer

```bash
# one-shot snapshot
node ~/projects/pi-instances/bin/pi-instances.mjs

# full-screen "top"-style dashboard (q quit, r refresh)
node ~/projects/pi-instances/bin/pi-instances.mjs top

# simple watch mode, refresh every 2s (or pass seconds)
node ~/projects/pi-instances/bin/pi-instances.mjs -w
node ~/projects/pi-instances/bin/pi-instances.mjs -w 1

# machine-readable ({ pi: [...], yonoAttach: [...] })
node ~/projects/pi-instances/bin/pi-instances.mjs --json
```

Handy shell alias (add to `~/.zshrc`):

```bash
alias pis='node ~/projects/pi-instances/bin/pi-instances.mjs top'
```

### `top` mode

A persistent, `top`-like dashboard that stays open in a spare pane and keeps a
visible list of everything running:

- **LOCAL PI** — local pi instances with live working/waiting status (from the
  registry).
- **YONO ATTACH** — your local `yono attach` sessions, showing which sandbox
  each is connected to. A recent `yono` CLI mirrors the sandbox agent's live
  **working/waiting** status into the registry (it decodes the same status
  beacon from the terminal stream it already receives — keyed by the attach PID,
  no cluster queries). Sessions from an older CLI, or before the first beacon,
  show `· att` with no status. Set `YONO_PI_INSTANCES=0` on the `yono` side to
  opt out.

It uses the terminal's alternate screen and restores it cleanly on `q`, Ctrl+C,
or exit.

Example:

```
pi instances  3 live · 1 working · 2 waiting   8:23:09 AM

STATUS   PID     PROJECT                                  AGE    ACTIVITY / MODEL
● work   62112   yono-worktree/main (feat/slack-chat)     4m     bash: make test
○ wait   61841   yono-worktree/gen1 (add-more-pi-ext)     2h     anthropic/claude-opus-4-8
○ wait   63001   pi-instances (main)                      1m     anthropic/claude-opus-4-8
```

## Inside pi

The extension registers `/instances` to print the list without leaving your
session, and `/instances-label` to name the current instance.

## Naming an instance

Give an instance a human-friendly label that shows as its primary name in the
viewer (and, by default, becomes the terminal/pane title):

```bash
PI_INSTANCE_LABEL="pr-review" pi     # set at launch
```

or from inside pi:

```
/instances-label pr-review          # set
/instances-label                    # show current
/instances-label -                  # clear
```

**Multiple panes:** each Ghostty split is its own process, so each pane gets its
own label and its own row in the viewer. The label is pushed to each pane's own
surface title, so Ghostty's tab bar shows whichever pane is focused. (There is
no way to read a Ghostty tab name *into* a program, so this is the reliable way
to name per-pane instances.) Disable the title push with `PI_INSTANCE_TITLE=0`.

## Remote sandboxes (yono)

When pi runs inside a [yono](https://github.com/grafana/yono) sandbox, the local
file registry is invisible to your laptop. The extension detects the sandbox
(via the `YONO_SANDBOX` / `SANDBOX_NAME` env vars yono sets) and additionally
reports status by writing a private OSC escape to its PTY:

```
ESC ] 6969 ; pi-status ; <base64(JSON)> BEL
```

Terminals ignore unknown OSC codes, so it is invisible under `yono attach`, and
it rides the terminal stream that already flows out of the sandbox — no new
transport. yono's `sessiond` harvests it and the supervisor turns it into the
sandbox's agent state (`working` → active, `waiting` → needs_input),
superseding yono's LLM terminal-guessing. It shows up in the yono dashboard,
`yono describe sandbox <name>` (Activity state / Latest activity), and the
sandbox-list MCP tool. See `extensions/beacon.ts` and, in the yono repo,
`cmd/yono/internal/sessiond/beacon.go`.

## Config

- `PI_CONFIG_DIR` — override the config dir (default `~/.pi`); the registry lives
  in `<config>/instances/`. The extension and viewer must agree, so set it for
  both if you change it.

## Files

| Path | Purpose |
|------|---------|
| `extensions/index.ts` | Registrar extension (writes/updates status files) |
| `extensions/registry.ts` | Shared schema + read/write/liveness helpers |
| `extensions/beacon.ts` | Sandbox OSC status beacon (yono integration) |
| `bin/pi-instances.mjs` | Zero-dependency viewer CLI |
