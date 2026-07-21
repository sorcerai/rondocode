# rondocode

Live-codeable synths and mini-notation patterns, in the browser. You write two
kinds of code. **Synths** are functions that wire oscillators, filters and
envelopes into a sound. **Patterns** are mini-notation sequences that trigger
those synths in time. A custom AudioWorklet DSP engine runs it all; nothing is
sampled unless you load a sample.

## Monorepo layout

pnpm workspace, TypeScript throughout. Packages import each other by name
(`@rondocode/pattern`, resolved to `src/` via workspace symlinks).

| Package | What it is |
| --- | --- |
| `@rondocode/pattern` | Pure pattern engine: `Pattern`/`Hap`/`TimeSpan`/`Fraction`, mini-notation parser, combinators, scales, chords, the scheduler, and the **MIDI importer** (`src/midi.ts`). No audio, no DOM. |
| `@rondocode/engine` | The DSP: oscillators, filters, envelopes, effects, the `synth()` builder, offline render, WAV encode. |
| `@rondocode/app` | The browser app: CodeMirror editor, the live audio session, the docs panel, the built-in examples (`src/examples/index.ts`). |
| `@rondocode/server` | Headless/bridge tooling and dev scripts. |

## Develop

```sh
pnpm install
pnpm dev        # vite dev server on http://localhost:6060
pnpm test       # the whole vitest suite
pnpm test:watch # watch mode
```

Type-check with `pnpm --filter @rondocode/app exec tsc --noEmit` (or per package).
**Do not run `tsc -b`** in this repo: it emits `.js` into `src/` and vite then
loads the stale `.js` over the `.ts`. Always use `tsc --noEmit`.

## The DSL

Everything you can write in an example is documented in-app (the docs panel) and
in `packages/app/src/docs/`:

- `dsl-docs.ts`, the reference: every scope global, `Pattern` method, synth-ctx
  member, `Sig` method and mini-notation operator. It is **coverage-pinned**:
  `test/docs.test.ts` checks it bidirectionally against the live objects
  (`baseScope`, `Pattern.prototype`, a probed `SynthCtx`/`Sig`), so adding a DSL
  name without documenting it (or documenting one that does not exist) fails
  the suite.
- `content.ts`, the hand-written guide: short sections that each end in a
  complete, playable program.

## Rendering examples headless

Render any built-in example to a WAV without a browser:

```sh
pnpm tsx packages/server/scripts/render-example.ts "veldt (full)" 52 out.wav
#                                                   <name>       <cycles> <out>
```

## Importing MIDI

`packages/pattern/src/midi.ts` is a from-scratch Standard-MIDI-File importer.
Tempo, time signature, note timing and the track split all come **from the
file**; none of it is guessed. There are three entry points:

- `parseMidi(bytes)` returns `{ ppq, tempoBpm, timeSig, tracks }` with exact-tick
  notes (handles running status, VLQs, tempo/time-sig meta, velocity-0
  note-offs, channel-10 drums).
- `midiNotesToPattern(notes, ppq, timeSig)` returns a **lossless** runtime
  `Pattern<ControlMap>`: exact fractional cycle timing, and a note can sustain
  across bar lines.
- `midiNotesToVoices(notes, ppq, timeSig, opts)` returns **editable**
  mini-notation: grid-quantized, held notes via `@` weights, polyphony split
  into stacked monophonic voice-lines.

Turn a `.mid` into a complete, editable example with the CLI:

```sh
pnpm tsx packages/server/scripts/midi-to-rondocode.ts song.mid "my song" out.txt
#   options:
#   --by-register   ignore (flaky) track labels; group notes by pitch into
#                   bass / keys / lead so parts play continuously. Use this
#                   for noisy transcriptions where instrument labels flicker.
#   --steps=N       grid resolution in steps per beat (default 4 = 1/16)
```

It picks a synth per track (from the track name, then the GM program), splits
drums by GM percussion pitch, derives `setCps` from the tempo, adds a sidechain
pump + master glue, and prints an example you can paste into the editor. 1 cycle
= 1 bar throughout. For a clean DAW MIDI the default one-synth-per-track is
faithful; `--by-register` is the robust fallback for messy transcriptions.

`midiToRondocode(bytes, opts)` in `packages/app/src/midi/import.ts` is the same
converter as a library function, ready to back an in-app "import MIDI" action.

## Context sonification

RondoCode turns an agent harness's context-window pressure into a continuously
generated danmaku-style soundtrack — a touhou-esque escalation that gets
denser, faster, and more contrapuntal as the agent's context fills, then
suspends and resolves when it compacts. No prerecorded stems or samples are
used: the browser runs one original RondoCode program of oscillators, filters,
envelopes, and mini-notation patterns. Telemetry ramps live synth parameters
continuously; only a pressure-zone or compaction change hot-swaps patterns.

The score runs in its own AudioWorklet `Session` beside the editor, sharing
only the browser `AudioContext`, so live-coding and context audio coexist
without either program bulldozing the other's synths, patterns, or transport.

### How pressure becomes music

The bridge normalizes each harness's context percentage into a smoothed 0–1
*pressure* value and maps it to one of six stable zones. Each zone layers in
more of the arrangement — bass and hats, then arpeggio and lead, then
countermelody, then the final "Last Spell" voice. Urgency comes from density,
counterpoint, brightness, and harmonic tension, not a volume climb.

| Zone | Context % | What enters the arrangement |
| --- | --- | --- |
| `open` | 0–34% | Main piano motif, pad, restrained half-time pulse |
| `flow` | 35–54% | Bass and first hats |
| `build` | 55–69% | Full kick, first arpeggio, and brass-like lead |
| `tense` | 70–82% | Faster hats and countermelody |
| `urgent` | 83–92% | Sixteenth-note arpeggio and brighter lead |
| `critical` | 93–100% | Critical "Last Spell" voice |
| `compact-start` | — | Drums fall away into a dominant suspension |
| `compact-end` | — | Resolving bell figure, then the low-pressure theme returns |

When the agent compacts, the drums fall away into a suspended dominant chord —
the spell card hanging in the air — and on compaction end a resolving bell
figure plays before the low-pressure theme returns: the clear. Hysteresis at
each zone boundary stops a 69.9 / 70.1 reading from rearranging the orchestra
every second.

### Run it

```sh
pnpm install

# terminal 1: browser app
pnpm dev

# terminal 2: WebSocket bridge + /context HTTP endpoint + focus watcher
pnpm bridge

# send a fake session to hear the escalation
pnpm context -- --source demo --session demo-1 --percent 18 --focused
pnpm context -- --source demo --session demo-1 --percent 72
pnpm context -- --source demo --session demo-1 --percent 96
pnpm context -- --source demo --session demo-1 --event compact-start
pnpm context -- --source demo --session demo-1 --event compact-end --percent 22
```

If this repo's `.mcp.json` already launched the RondoCode MCP server, skip
`pnpm bridge`: the MCP stdio process hosts the same bridge and `/context`
endpoint. Open `http://localhost:6060`; the first click or keypress unlocks
browser audio.

### Agentic harness setup

OMP, Pi, and Claude Code all speak the same normalized protocol — a JSON body
to `POST http://127.0.0.1:6070/context` with a `sessionId` and either a
percentage or token counts. Any harness that can emit a percentage can drive
it through the generic `pnpm context` CLI too.

- **OMP / Pi** — copy the shared extension into the harness's `extensions/`
  directory and restart. It reports usage on session start, each user input,
  and agent completion, plus the before/after compaction events. The same
  extension adds a `/music` slash command (`on` / `off` / `toggle` / `status`)
  to mute or resume the soundtrack.
- **Claude Code** — a status-line command forwards
  `context_window.used_percentage`, and `PreCompact` / `PostCompact` /
  `SessionEnd` hooks fire the suspension → release arc.

Full setup JSON, environment variables, the foreground-window watcher, and the
wire protocol live in [docs/context-sonification.md](docs/context-sonification.md).

## Inspiration

rondocode's pattern model (cycle-based patterns and the terse mini-notation)
follows in the lineage of [TidalCycles](https://tidalcycles.org) and
[Strudel](https://strudel.cc). The pattern engine, DSP, editor, and everything
else here are written from scratch, with no Tidal or `@strudel/*` dependency;
where a behavior matches theirs it's for parity, noted in the code.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev
workflow and ground rules, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
Example tunes must be original compositions (no transcriptions of copyrighted
songs).

## License

[MIT](LICENSE) © Vijay Pemmaraju.
