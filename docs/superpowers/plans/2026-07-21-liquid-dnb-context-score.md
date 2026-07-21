# Liquid DnB Context Score Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the context soundtrack into an original 174-BPM liquid DnB/artcore arrangement whose zone changes are observable as discrete two-step, rhythm, harmonic, and layer changes.

**Architecture:** `packages/server/src/danmaku-score.ts` is the entire generated-score boundary: it owns synth definitions, zone patterns, modes, and CPS. `ContextService` already selects a new score source when its `normal:<zone>` key changes; retain that behavior and lock it with a bridge-call test. The browser peer session and continuous `contextMix()` controls remain unchanged.

**Tech Stack:** TypeScript, Vitest, `@rondocode/pattern`, app-side `evalCode`, RondoCode offline renderer.

## Global Constraints

- Preserve `danmakuContextScore(zone, mode)`, `ContextScoreMode`, all six zones, the independent context peer session, and compaction/release behavior.
- Keep the `SYNTHS` template byte-identical for every generated mode and retain all 12 `CONTEXT_SCORE_SYNTHS` names.
- Do not add synth names, bridge methods, dependencies, samples, or telemetry changes.
- Every `contextMix()` parameter address (`bright` and `ctx_lead.vibrato`) must remain valid.
- Use only original D-minor musical material. No direct melody quotation; no PC-98/ZUNpet, chiptune, gabba, breakcore overload, or four-on-the-floor critical-zone beat.
- Do not make or push another git commit unless the user explicitly asks.

---

## File Structure

- `packages/server/src/danmaku-score.ts` — revoice `ctx_bass`; declare liquid groove/harmony material; select non-overlapping patterns by zone; retain compaction/release strings and mix topology.
- `packages/server/test/danmaku-score.test.ts` — inspect evaluated score events to defend the two-step, backbeat, swing, sustained bass, and zone-only layer contracts.
- `packages/server/test/context-service.test.ts` — assert that a zone crossing sends a new, distinct `startContextScore` source, while pressure movement within a zone only calls `applyContext`.
- `docs/superpowers/specs/2026-07-21-liquid-dnb-context-score-design.md` — approved design reference; no further edit in this plan.

## Task 1: Defend and implement the liquid zone arrangement

**Files:**
- Modify: `packages/server/test/danmaku-score.test.ts:12-56`
- Modify: `packages/server/src/danmaku-score.ts:5-6,63-71,178-267`

**Interfaces:**
- Consumes: `danmakuContextScore(zone, mode)`, `evalCode(source, baseScope)`, `Pattern.query(TimeSpan)`, `hasOnset`.
- Produces: Original generated source at `CONTEXT_SCORE_CPS === 174 / 240`; `normal:5` emits a two-step kick, 2/4 snare backbeat, swung sixteenth hats, sustained bass, and high-zone-only layers.

- [ ] **Step 1: Add event-inspection helpers and the red arrangement test**

Add these helpers immediately after `evaluate` in `packages/server/test/danmaku-score.test.ts`:

```ts
const eventsFor = (zone: ContextZone, name: string) => {
  const pattern = evaluate(zone).patterns.get(name)
  expect(pattern, `pattern '${name}'`).toBeDefined()
  return pattern!.query(new TimeSpan(F(0), F(1))).filter(hasOnset)
}

const onsetsFor = (zone: ContextZone, name: string) =>
  eventsFor(zone, name).map((hap) => hap.whole!.begin.valueOf())
```

Add this test before `keeps synth graphs stable`:

```ts
it('turns critical pressure into a swung liquid two-step arrangement', () => {
  expect(onsetsFor(5, 'ctx_kick')).toEqual([0, 5 / 8])
  expect(onsetsFor(5, 'ctx_snare')).toEqual([1 / 4, 3 / 4])
  expect(onsetsFor(5, 'ctx_hat_fast')).toContain(1 / 12)
  expect(onsetsFor(5, 'ctx_hat_fast')).not.toContain(1 / 16)
  expect(eventsFor(5, 'ctx_bass').some((hap) => hap.value.dur === 0.82)).toBe(true)
  expect([...evaluate(2).patterns.keys()]).not.toContain('ctx_ghost')
  expect([...evaluate(5).patterns.keys()]).toEqual(
    expect.arrayContaining(['ctx_ghost', 'ctx_hat_fast', 'ctx_counter', 'ctx_last']),
  )
})
```

- [ ] **Step 2: Run the new test before changing production code**

Run:

```bash
corepack pnpm@9.0.0 exec vitest run packages/server/test/danmaku-score.test.ts
```

Expected: the new test fails at the kick assertion because current `DRUMS_FULL` emits four onsets (`0`, `1/4`, `1/2`, `3/4`) from `note('c1*4')`.

- [ ] **Step 3: Replace the current 164-BPM/straight-four arrangement with the locked liquid material**

Change the tempo header and constant to:

```ts
/** 174 BPM when one cycle is one 4/4 bar: bpm / 60 / 4. */
export const CONTEXT_SCORE_CPS = 174 / 240
```

Replace only the `ctx_bass` synth definition with this mono sub/Reese voice; leave its name and `bright` parameter intact:

```ts
const ctx_bass = synth(
  ({ note, gate, param, adsr, saw, onepole }) => {
    const bright = param('bright', 700, { min: 120, max: 2600, curve: 'log' })
    const env = adsr(gate, { a: 0.012, d: 0.28, s: 0.82, r: 0.32 })
    const sub = saw(note.freq).mul(0.78)
    const reese = saw(note.freq.mul(1.003))
      .add(saw(note.freq.mul(0.997)))
      .mul(0.18)
    return onepole(sub.add(reese), bright).mul(env).mul(0.48).tanh()
  },
  { mono: true, glide: 0.025, voices: 1 },
)
```

Replace the arrangement declarations from `commonPatterns` through `normalPatterns` with the following complete block. Keep `COMPACTING`, `RELEASE`, and `MIX` unchanged.

```ts
const commonPatterns = (upper: boolean) => `
const ctxHarmony = chord('${upper ? '<Dm9 Gm9 Bbmaj7 A7>' : '<Dm9 Bbmaj7 Fadd9 A7>'}')
const ctxRoots = note('<d2 bb1 f2 a1>')
const ctxTheme = note('d5 f5 a5 c6 a5 f5 e5 d5')
const ctxAnswer = note('f5 a5 c6 a5 g5 f5 e5 c#5')

p('ctx_pad', ctxHarmony.sound('ctx_pad').dur(0.98).gain(0.5))
p('ctx_theme', cat(ctxTheme, ctxAnswer).sound('ctx_piano').dur(0.72).gain(0.68))
`

const FLOW = `
p('ctx_bass', ctxRoots.sound('ctx_bass').dur(0.9).gain(0.42))
p('ctx_flow_hat', note('~ c6 ~ ~ ~ c6 ~ ~').sound('ctx_hat').gain(0.28))
`

const DRUMS_TWO_STEP = `
p('ctx_kick', note('c1 ~ ~ ~ ~ ~ ~ ~ ~ ~ c1 ~ ~ ~ ~ ~').sound('ctx_kick').gain(0.78))
p('ctx_snare', note('~ ~ ~ ~ c3 ~ ~ ~ ~ ~ ~ ~ c3 ~ ~ ~').sound('ctx_snare').gain(0.64))
`

const BASS = `
p('ctx_bass', ctxRoots.sound('ctx_bass').dur(0.82).gain(0.62))
`

const HATS = `
p('ctx_hat', note('~ c6 ~ c6 ~ c6 ~ c6 ~ c6 ~ c6 ~ c6 ~ c6')
  .swing(8)
  .sound('ctx_hat')
  .gain(0.42))
`

const GHOSTS = `
p('ctx_ghost', note('~ ~ c3 ~ ~ ~ ~ c3 ~ ~ c3 ~ ~ ~ ~ c3')
  .sound('ctx_snare')
  .dur(0.22)
  .gain(0.18))
`

const HATS_FAST = `
p('ctx_hat_fast', note('c7*16').swing(8).sound('ctx_hat_fast').gain(0.44))
`

const ARP_SLOW = `
p('ctx_arp', ctxHarmony.arp('updown').fast(2).sound('ctx_arp').dur(0.34).gain(0.54))
`

const ARP_FAST = `
p('ctx_arp', ctxHarmony.arp('updowninc').fast(4).sound('ctx_arp').dur(0.22).gain(0.52))
`

const LEAD = `
p('ctx_lead', cat(
  note('d5 f5 a5 c6 a5 f5 e5 d5'),
  note('bb4 d5 f5 a5 g5 f5 e5 c#5'),
).sound('ctx_lead').dur(0.86).gain(0.5))
`

const LEAD_URGENT = `
p('ctx_lead', cat(
  note('d5 a5 c6 d6 c6 a5 g5 f5'),
  note('f5 a5 d6 c#6 d6 a5 f5 e5'),
).sound('ctx_lead').dur(0.78).gain(0.54))
`

const COUNTER = `
p('ctx_counter', cat(
  note('a5 ~ g5 f5 e5 ~ f5 g5'),
  note('d6 c#6 ~ a5 bb5 a5 g5 e5'),
).sound('ctx_counter').dur(0.58).gain(0.44))
`

const LAST = `
p('ctx_last', cat(
  note('d6 e6 f6 a6 g6 f6 e6 c#6'),
  note('d6 a5 bb5 c6 d6 f6 e6 c#6'),
).fast(2).sound('ctx_last').dur(0.38).gain(0.48))
`

const CRITICAL_FILL = `
p('ctx_fill', note('~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ ~ c3 c3 c3')
  .sound('ctx_snare')
  .dur(0.16)
  .gain(0.28))
`

const normalPatterns = (zone: ContextZone): string => {
  const parts = [commonPatterns(zone >= 4)]
  if (zone === 1) parts.push(FLOW)
  if (zone >= 2) parts.push(DRUMS_TWO_STEP, BASS, HATS)
  if (zone >= 2 && zone < 4) parts.push(ARP_SLOW, LEAD)
  if (zone >= 3) parts.push(GHOSTS, HATS_FAST, COUNTER)
  if (zone >= 4) parts.push(ARP_FAST, LEAD_URGENT)
  if (zone >= 5) parts.push(LAST, CRITICAL_FILL)
  return parts.join('\n')
}
```

- [ ] **Step 4: Run the score test and typecheck**

Run:

```bash
corepack pnpm@9.0.0 exec vitest run packages/server/test/danmaku-score.test.ts
corepack pnpm@9.0.0 exec tsc --noEmit -p packages/server/tsconfig.json
```

Expected: both commands exit `0`; every zone still evaluates, every generated pattern produces sound, and the new event-level test passes.

- [ ] **Step 5: Do not commit or push**

The user approved keeping only the existing local design commit. Leave implementation changes uncommitted unless the user makes a separate explicit commit request.

## Task 2: Lock zone hot-swap source selection in ContextService

**Files:**
- Modify: `packages/server/test/context-service.test.ts:47-59`

**Interfaces:**
- Consumes: `ContextService.ingest(ContextInput)` and `ContextBrowserBridge.call('startContextScore', { source, cps })`.
- Produces: A regression test proving a cross-zone pressure update sends a new score source while an in-zone pressure update does not.

- [ ] **Step 1: Extend the existing continuous-update test with source assertions**

Replace the body of the existing `loads the score once...` test with:

```ts
const { service, calls } = rig()
await service.ingest({ sessionId: 's', source: 'pi', rawPercent: 20, focused: true })
const initial = calls.find((call) => call.method === 'startContextScore')!
const initialSource = (initial.params as { source: string }).source
expect(calls.map((call) => call.method)).toEqual(['startContextScore', 'applyContext'])

calls.length = 0
await service.ingest({ sessionId: 's', source: 'pi', rawPercent: 28 })
expect(calls.map((call) => call.method)).toEqual(['applyContext'])

calls.length = 0
await service.ingest({ sessionId: 's', source: 'pi', rawPercent: 72 })
const changed = calls.find((call) => call.method === 'startContextScore')!
const changedSource = (changed.params as { source: string }).source
expect(calls.map((call) => call.method)).toEqual(['startContextScore', 'applyContext'])
expect(changedSource).not.toBe(initialSource)
expect(changedSource).toContain("p('ctx_ghost'")
```

- [ ] **Step 2: Run the focused service test after Task 1**

Run:

```bash
corepack pnpm@9.0.0 exec vitest run packages/server/test/context-service.test.ts
```

Expected: all service tests pass. The source-switch assertions prove `ContextService` already reevaluates on zone changes; no `context-service.ts` change is required.

- [ ] **Step 3: Do not change ContextService**

`syncNow()` already derives `key = normal:<zone>` and calls `startContextScore({ source: danmakuContextScore(state.zone, mode), cps })` only when the key changes. The test is the deliverable: no bridge, telemetry, or service implementation change is needed.

- [ ] **Step 4: Do not commit or push**

Leave the regression-test change uncommitted unless the user explicitly asks for a commit.

## Task 3: Render and exercise the end-to-end score path

**Files:**
- No source changes required.

**Interfaces:**
- Consumes: the completed `danmakuContextScore(5)` program and the MCP bridge’s `startContextScore`/`applyContext` behavior.
- Produces: offline evidence that the new zone-5 program renders and live evidence that a zone crossing changes `scoreKey` and starts a replacement arrangement.

- [ ] **Step 1: Run the complete automated gate**

Run:

```bash
corepack pnpm@9.0.0 exec tsc --noEmit -p packages/server/tsconfig.json
corepack pnpm@9.0.0 test
```

Expected: both commands exit `0` and the full Vitest suite reports no failed tests.

- [ ] **Step 2: Render revised critical-zone audio offline**

Call `mcp__rondocode_render_code` with the full string returned by `danmakuContextScore(5)` and `cycles: 8`. Record the returned WAV path and metrics. The render must report nonzero events and RMS for `ctx_kick`, `ctx_snare`, `ctx_bass`, `ctx_hat_fast`, `ctx_counter`, and `ctx_last`.

- [ ] **Step 3: Smoke-test live zone replacement**

With the bridge running, send focused HTTP payloads using `rawPercent` values in 0–100 units (not fractions): start below the zone-1 threshold, then send repeated high-pressure values to traverse smoothing and hysteresis through `normal:4` into `normal:5`. Confirm `/context/status` reaches `normal:5`; inspect bridge calls for `startContextScore` sources containing the altered zone-4 harmony and zone-5 `ctx_fill`; then send a further in-zone update and confirm it only receives `applyContext`.

- [ ] **Step 4: Run the mandatory final code-review pass**

Dispatch a `code-reviewer` subagent after every automated gate and smoke check passes. Give it the final implementation diff, this plan, and the requirement to inspect score syntax, zone-gating regressions, preservation of synth/bridge contracts, and test adequacy. Fix every Critical or Important finding, then rerun the affected verification commands.

- [ ] **Step 5: Do not commit or push**

Report the test output, offline render metrics/WAV path, live smoke-test observations, and review result. Leave implementation changes uncommitted unless the user explicitly asks for a commit.
