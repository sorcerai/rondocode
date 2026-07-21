# Context sonification

RondoCode can turn an agent harness's context-window pressure into a continuously
generated danmaku-style soundtrack.

There are no WAV stems. The browser runs one original RondoCode program made of
oscillators, filters, envelopes, effects, and mini-notation patterns. Telemetry
ramps live synth parameters continuously; only a pressure-zone or compaction
change hot-swaps pattern registrations. The synth graphs and transport stay
live.

The soundtrack has its own AudioWorklet engine and `Session`, sharing the
editor's `AudioContext` but not its synth registry, patterns, or transport. It
can play beside whatever is being live-coded without either program bulldozing
the other. Software finally learns to share a room.

## What you hear

| Effective pressure | Score state |
| ---: | --- |
| 0–34% | Main piano motif, pad, restrained half-time pulse |
| 35–54% | Bass and first hats |
| 55–69% | Full kick, first arpeggio, and brass-like lead |
| 70–82% | Faster hats and countermelody |
| 83–92% | Sixteenth-note arpeggio and brighter lead |
| 93–100% | Critical “Last Spell” voice |
| compact-start | Drums fall away into a dominant suspension |
| compact-end | Resolving bell figure, then the low-pressure theme returns |

The pressure engine smooths normal updates and uses hysteresis around zone
boundaries. It snaps downward after compaction so the musical release is clear.

## Run it

```sh
pnpm install

# terminal 1: browser app
pnpm dev

# terminal 2: WebSocket bridge + context HTTP endpoint + focus watcher
pnpm bridge

# optional: run the focus watcher alone while debugging its permissions/matches
pnpm context:focus
```

When this repo's `.mcp.json` has already launched the RondoCode MCP server, skip
`pnpm bridge`: the MCP stdio process now hosts the same WebSocket bridge,
`/context` HTTP endpoint, and focus watcher. Do not launch both on port 6070 and
then act surprised when TCP declines the group project.

Open `http://localhost:6060`. The first click or keypress unlocks browser audio.
That is a browser autoplay restriction, not an artistic choice.

Send a fake session:

```sh
pnpm context -- \
  --source demo \
  --session demo-1 \
  --percent 18 \
  --focused

pnpm context -- --source demo --session demo-1 --percent 72
pnpm context -- --source demo --session demo-1 --percent 96
pnpm context -- --source demo --session demo-1 --event compact-start
pnpm context -- --source demo --session demo-1 --event compact-end --percent 22
```

Inspect the current bridge/session state:

```sh
curl -s http://127.0.0.1:6070/context/status | jq
```

## Normalized protocol

All harnesses post the same JSON shape to `POST http://127.0.0.1:6070/context`:

```json
{
  "version": 1,
  "source": "pi",
  "model": "anthropic/claude-sonnet",
  "sessionId": "session-abc",
  "event": "usage",
  "cwd": "/work/project",
  "usedTokens": 142000,
  "contextWindow": 200000,
  "reserveTokens": 16384,
  "rawPercent": 71,
  "focused": true
}
```

Only `sessionId` is mandatory. Usage may be supplied as `rawPercent`, or as
`usedTokens` plus a context/effective limit. Token counts win when both forms
are present, which lets Pi/OMP account for a reserved compaction margin. The
Claude adapter sends Claude's precomputed percentage without a competing token
estimate.

Events:

```text
usage
compact-start
compact-end
focus
session-end
```

`focused: true` selects that session. `focused: false` clears it from the active
audio slot. The server tracks every reported session but drives one context
score at a time. Compaction and release transitions are scoped to their source
session, so a background harness cannot resolve the foreground soundtrack by
accident.

## Claude Code

The status-line adapter forwards `context_window.used_percentage` and still
prints a compact status line.

Replace `/ABSOLUTE/PATH/TO/rondocode` below:

```json
{
  "statusLine": {
    "type": "command",
    "command": "pnpm --dir /ABSOLUTE/PATH/TO/rondocode context:claude-statusline"
  },
  "hooks": {
    "PreCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "pnpm --dir /ABSOLUTE/PATH/TO/rondocode context:claude-hook"
          }
        ]
      }
    ],
    "PostCompact": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "pnpm --dir /ABSOLUTE/PATH/TO/rondocode context:claude-hook"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "pnpm --dir /ABSOLUTE/PATH/TO/rondocode context:claude-hook"
          }
        ]
      }
    ]
  }
}
```

Do not add a periodic `refreshInterval` to this status line when several Claude
sessions are open. Event-driven invocations make the most recently interacted
session active; background refreshes would make idle terminals compete for the
soundtrack.

## Pi

Copy the extension into Pi's global extension directory:

```sh
mkdir -p ~/.pi/agent/extensions/rondocode-context
cp packages/server/adapters/pi-omp-extension.ts \
  ~/.pi/agent/extensions/rondocode-context/index.ts
```

Restart Pi or run `/reload`. The adapter reports usage on session start, user
input, and agent completion, plus the before/after compaction events.

Pi's default reserve assumption is 16,384 tokens. Override it when your setup
uses another value:

```sh
export RONDOCODE_RESERVE_TOKENS=20000
```

## OMP

OMP exposes the same extension lifecycle needed here. Copy the same adapter to
its agent extension directory:

```sh
mkdir -p ~/.omp/agent/extensions/rondocode-context
cp packages/server/adapters/pi-omp-extension.ts \
  ~/.omp/agent/extensions/rondocode-context/index.ts

# Usually unnecessary; only set this when a custom launcher defeats auto-detection.
export RONDOCODE_SOURCE=omp
```

If your OMP installation points at a custom agent/config directory, place the
whole `rondocode-context/` directory in that directory's `extensions/` folder.

## /music

The shared OMP/Pi extension registers a `/music` slash command that mutes or
resumes the context soundtrack without restarting anything:

```text
/music            toggle on/off
/music on         enable
/music off        disable
/music toggle     flip current state
/music status     show whether it is currently on
```

`/music off` mutes exactly the way a backgrounded window does — the score keeps
its place and resumes instantly on `/music on`. The command talks to the local
bridge (`POST /context/music`), so it works from any OMP terminal regardless of
which one is foreground. If no bridge is running it says so.

## Foreground-window gate

Both `pnpm bridge` and the bundled MCP stdio process start the foreground
watcher automatically on macOS and Linux. `pnpm context:focus` runs the same
watcher by itself for debugging. It polls the frontmost window and posts a
global audible/mute gate. It supports:

- macOS through System Events
- Linux through `xdotool`

Default coding apps are Terminal, iTerm2, Warp, Ghostty, Visual Studio Code,
Cursor, Zed, and Windsurf. Override the list:

```sh
export RONDOCODE_FOCUS_APPS="Ghostty,Cursor,Google Chrome"
pnpm context:focus
```

On macOS, grant the shell or terminal Accessibility permission when prompted.
The watcher also sends the front-window title; RondoCode uses a matching project
folder or session ID to select among registered sessions. If the bridge process
disconnects, the browser stops the context transport immediately and restarts it
from retained telemetry only after a successful reconnect.

Focus follows user interaction, not background telemetry. Each harness claims
the foreground only on its interaction event — `input` for OMP/Pi, the
status-line render for Claude Code; background lifecycle events (agent
completion, compaction hooks) update pressure without claiming focus. When
several same-repo sessions match a window title, `matchTitle` keeps the
already-active session rather than letting a newer background update steal it.
The terminal you last interacted with holds the soundtrack until you interact
with another; the only gap is the moment between switching windows and your
next keystroke or status-line render. The global coding-app mute gate applies
throughout.

## Other harnesses

Any harness that exposes a percentage can use the generic CLI:

```sh
echo '{
  "source": "my-harness",
  "sessionId": "abc",
  "rawPercent": 64,
  "focused": true
}' | pnpm context
```

Or post directly:

```sh
curl -s http://127.0.0.1:6070/context \
  -H 'content-type: application/json' \
  -d '{"source":"my-harness","sessionId":"abc","rawPercent":64,"focused":true}'
```

The context endpoint intentionally does not expose permissive browser CORS and
requires `application/json` for writes. Local adapters and `curl` work; random
web pages do not get to inspect project paths or conduct the soundtrack.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `6070` | Local bridge port |
| `RONDOCODE_CONTEXT_URL` | `http://127.0.0.1:6070/context` | Adapter endpoint |
| `RONDOCODE_RESERVE_TOKENS` | `16384` | Pi/OMP effective-limit reserve |
| `RONDOCODE_SOURCE` | auto-detected | Override the Pi/OMP source label |
| `RONDOCODE_FOCUS_APPS` | common coding apps | Foreground allowlist |
| `RONDOCODE_FOCUS_INTERVAL_MS` | `700` | Foreground poll interval |
| `RONDOCODE_FOCUS_WATCHER` | enabled | Set to `0` to disable automatic focus polling in bridge/MCP processes |

## Design constraints

- Thresholds are stable so the ear can learn them.
- Variation is deterministic and lives inside the composition.
- Urgency comes from density, counterpoint, brightness, and harmonic tension,
  not a crude volume climb.
- Compaction hooks are authoritative; a large percentage drop is only a
  fallback inference.
- The soundtrack is original and must not transcribe copyrighted game music.
