# Liquid DnB Context Score Design

## Decision

Rework the procedural context soundtrack into an original 174 BPM liquid drum-and-bass/artcore roller. It should gain recognizable rhythmic and harmonic material as pressure crosses zones; it must not rely on PC-98, ZUNpet, chiptune, hardcore/gabba, direct melody quotation, or any change to the telemetry/bridge architecture.

## Evidence

Live `/context/status` showed the bridge and score path are healthy: browser connected, score started, active session at pressure `0.663`, zone `3` (`tense`), and score key `normal:3`. `ContextService` re-evaluates the score when its zone key changes; the browser peer `Session` hot-swaps and removes patterns. The audible problem is the arrangement: within a zone, pressure changes only gain/filter controls; zone changes add too little material; and `DRUMS_FULL` is four-on-the-floor (`c1*4`).

## Locked Contracts

- Preserve `danmakuContextScore(zone, mode)`, `ContextScoreMode`, six pressure zones, compaction/release semantics, and the independent context peer audio session.
- Preserve the byte-stable `SYNTHS` block across modes, every existing `contextMix()` parameter address, existing channel registry, sidechain architecture, and mute/foreground behavior.
- Do not add synth names in this pass. Revoice existing bass, drum, hat, pad, keys, arp, lead, counter, and last-spell roles instead.
- Use original melodic and harmonic material only. Do not reconstruct or paraphrase a specific Touhou, Alstroemeria Records, or other copyrighted track.

## Musical Design

### Tempo and Harmony

- Set `CONTEXT_SCORE_CPS` to `174 / 240`.
- Use extended original D-minor colors: `Dm9`, `Bbmaj7`, `Fadd9`, `A7`; use a distinct upper-zone turnaround so high pressure changes harmonic motion as well as density.
- Keep compaction as a dominant suspension and release as a sparse tonic resolution.

### Palette

- Revoice `ctx_bass` from a short saturated pluck into a sustained, clean low sub with a restrained detuned mid layer. Keep it mono and pressure-filtered.
- Keep the pad/keys/lead roles, but bias them toward liquid/artcore: breathing pad, bright electric-piano-like attack, filtered airy lead, glassy delayed arp. Avoid raw pulse/square-only leads.
- Keep existing synth names so `contextMix()` and global mute continue to control every audible layer.

### Groove

- Zone 2+ is a liquid two-step, never four-on-the-floor: primary kick at bar start plus an offbeat push; snare backbeat at beats 2 and 4.
- Zone 3+ adds low-gain ghost percussion and a swung 16th hat layer. `swing(8)` is verified in the local pattern DSL as the correct modifier for odd sixteenth-note movement.
- High zones add rolling density and a last-spell cascade, without breakcore retrigger overload or hardcore double-kicks.

### Pressure Ladder

| Zone | Arrangement |
| --- | --- |
| 0 — open | Pad + keys only; intentional liquid intro, no regular beat. |
| 1 — flow | Sparse sub/root pulse and first drum hint. |
| 2 — build | Full two-step, offbeat hats, slow arp, first lead phrase. |
| 3 — tense | Ghost percussion, swung 16ths, counterline. |
| 4 — urgent | Faster arp, replacement high-pressure lead phrase, altered turnaround. |
| 5 — critical | Full roller plus last-spell cascade and bar-end fill. |

Continuous pressure retains the existing brightness, vibrato, and channel-gain ramps. Zone crossings own discrete arrangement changes.

## Regression Tests

Write tests before production changes:

1. A high-zone score must emit a broken two-step kick pattern, not four evenly spaced quarter-note kicks.
2. High-zone snare must retain beats 2 and 4; high-zone percussion must include a separate ghost/swing layer.
3. High-zone bass must contain a sustained root event, and high-zone arrangement must register material absent from lower zones.
4. `ContextService` must send a distinct `startContextScore` source on a zone crossing, proving the arrangement path is not reduced to continuous parameter updates.

## Verification

- Observe each new regression test fail against the current score before changing production code.
- Render current and revised zone 5 offline; compare event timing and spectral balance, and provide the generated WAVs for human A/B listening.
- Run server typecheck and the full Vitest suite.
- Smoke-test the live browser + bridge by moving a demo or active context session across at least two zone thresholds and confirming `/context/status.scoreKey` changes with audible arrangement changes.
