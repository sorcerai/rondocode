import type { ContextZone } from './context-telemetry'

export type ContextScoreMode = 'normal' | 'compacting' | 'release'

/** 164 BPM when one cycle is one 4/4 bar: bpm / 60 / 4. */
export const CONTEXT_SCORE_CPS = 164 / 240

export const CONTEXT_SCORE_SYNTHS = [
  'ctx_pad',
  'ctx_piano',
  'ctx_bass',
  'ctx_kick',
  'ctx_snare',
  'ctx_hat',
  'ctx_hat_fast',
  'ctx_arp',
  'ctx_lead',
  'ctx_counter',
  'ctx_last',
  'ctx_release',
] as const

/*
 * Original, synthesized danmaku score. The synth block is byte-for-byte stable
 * across modes so Session.evalCode hot-swaps patterns without rebuilding voice
 * pools. Pressure-specific brightness and layer gains arrive through setParam /
 * setChannel, while the zone decides which musical lines exist.
 */
const SYNTHS = `
const ctx_pad = synth(
  ({ note, gate, param, adsr, saw, svf, lfo }) => {
    const bright = param('bright', 900, { min: 200, max: 5000, curve: 'log' })
    const env = adsr(gate, { a: 0.22, d: 0.5, s: 0.82, r: 1.4 })
    const f = note.freq
    const wide = saw(f)
      .add(saw(f.mul(1.004)))
      .add(saw(f.mul(0.996)))
      .mul(0.34)
    return svf(wide, bright.mul(lfo(0.08).range(0.72, 1.18)), { res: 0.16 })
      .mul(env)
      .mul(0.42)
  },
  ({ input, chorus, reverb }) => {
    const wide = chorus(input, { rate: 0.45, depth: 0.004, mix: 0.55 })
    return wide.mix(reverb(wide, { roomSize: 0.86, damp: 0.42 }), 0.36)
  },
  { voices: 10 },
)

const ctx_piano = synth(
  ({ note, gate, param, adsr, sine, tri, svf }) => {
    const bright = param('bright', 2400, { min: 400, max: 8000, curve: 'log' })
    const strike = adsr(gate, { a: 0.0015, d: 0.42, s: 0.08, r: 0.42 })
    const body = sine(note.freq)
      .add(sine(note.freq.mul(2.01)).mul(0.31))
      .add(tri(note.freq.mul(3.98)).mul(0.12))
    return svf(body, bright, { res: 0.12 }).mul(strike).mul(0.56)
  },
  ({ input, reverb }) => input.mix(reverb(input, { roomSize: 0.62, damp: 0.36 }), 0.24),
  { voices: 10 },
)

const ctx_bass = synth(
  ({ note, gate, param, adsr, pulse, saw, onepole }) => {
    const bright = param('bright', 700, { min: 120, max: 2600, curve: 'log' })
    const env = adsr(gate, { a: 0.004, d: 0.18, s: 0.55, r: 0.12 })
    const tone = pulse(note.freq, 0.42).mix(saw(note.freq.mul(0.5)), 0.28)
    return onepole(tone, bright).mul(env).mul(0.56).tanh()
  },
  { mono: true, glide: 0.025, voices: 1 },
)

const ctx_kick = synth(({ gate, adsr, sine, noise, svf }) => {
  const pitch = adsr(gate, { a: 0.001, d: 0.075, s: 0, r: 0.04 })
  const amp = adsr(gate, { a: 0.001, d: 0.19, s: 0, r: 0.055 })
  const body = sine(pitch.pow(2.5).range(46, 185)).mul(amp)
  const click = svf(noise(), 4200, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.0005, d: 0.012, s: 0, r: 0.008 }))
    .mul(0.28)
  return body.add(click).mul(1.25).tanh()
}, { voices: 2 })

const ctx_snare = synth(({ gate, adsr, sine, noise, svf }) => {
  const body = sine(185).mul(adsr(gate, { a: 0.001, d: 0.11, s: 0, r: 0.05 }))
  const crack = svf(noise(), 2500, { mode: 'bp', res: 0.42 })
    .mul(adsr(gate, { a: 0.001, d: 0.16, s: 0, r: 0.08 }))
  const air = svf(noise(), 7200, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.001, d: 0.055, s: 0, r: 0.03 }))
    .mul(0.42)
  return body.add(crack).add(air).mul(0.82).tanh()
}, { voices: 2 })

const ctx_hat = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 9200, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.001, d: 0.038, s: 0, r: 0.02 }))
    .mul(0.24),
  { voices: 2 },
)

const ctx_hat_fast = synth(({ gate, adsr, noise, svf }) =>
  svf(noise(), 11200, { mode: 'hp' })
    .mul(adsr(gate, { a: 0.001, d: 0.019, s: 0, r: 0.012 }))
    .mul(0.18),
  { voices: 2 },
)

const ctx_arp = synth(
  ({ note, gate, param, adsr, saw, square, svf }) => {
    const bright = param('bright', 3200, { min: 500, max: 9000, curve: 'log' })
    const env = adsr(gate, { a: 0.0015, d: 0.105, s: 0.03, r: 0.11 })
    const osc = saw(note.freq).mix(square(note.freq.mul(2)), 0.18)
    return svf(osc, bright.mul(env.range(0.55, 1)), { res: 0.38 })
      .mul(env)
      .mul(0.38)
  },
  ({ input, delay, reverb }) => {
    const echo = input.add(delay(input, 0.183, 0.28))
    return echo.mix(reverb(echo, { roomSize: 0.64, damp: 0.32 }), 0.23)
  },
  { voices: 8 },
)

const ctx_lead = synth(
  ({ note, gate, param, adsr, saw, pulse, svf, lfo }) => {
    const bright = param('bright', 4200, { min: 700, max: 9500, curve: 'log' })
    const vibrato = param('vibrato', 5.2, { min: 1, max: 9 })
    const freq = note.freq.mul(lfo(vibrato, 'sine').range(0.9965, 1.0035))
    const env = adsr(gate, { a: 0.012, d: 0.2, s: 0.72, r: 0.24 })
    const voice = saw(freq)
      .add(saw(freq.mul(1.006)))
      .add(saw(freq.mul(0.994)))
      .add(pulse(freq.mul(0.5), 0.46).mul(0.32))
      .mul(0.31)
    return svf(voice, bright, { res: 0.2 }).mul(env).mul(0.44)
  },
  ({ input, delay, reverb }) => {
    const echo = input.add(delay(input, 0.244, 0.26))
    return echo.mix(reverb(echo, { roomSize: 0.72, damp: 0.38 }), 0.27)
  },
  { mono: true, glide: 0.035, unison: 3, detune: 11, spread: 0.55, voices: 1 },
)

const ctx_counter = synth(
  ({ note, gate, param, adsr, tri, pulse, svf }) => {
    const bright = param('bright', 3400, { min: 500, max: 9000, curve: 'log' })
    const env = adsr(gate, { a: 0.006, d: 0.14, s: 0.36, r: 0.18 })
    const tone = tri(note.freq).mix(pulse(note.freq.mul(2), 0.36), 0.26)
    return svf(tone, bright, { res: 0.24 }).mul(env).mul(0.35)
  },
  ({ input, reverb }) => input.mix(reverb(input, { roomSize: 0.67, damp: 0.34 }), 0.2),
  { voices: 6 },
)

const ctx_last = synth(
  ({ note, gate, param, adsr, syncsaw, pulse, svf }) => {
    const bright = param('bright', 5200, { min: 900, max: 10000, curve: 'log' })
    const env = adsr(gate, { a: 0.003, d: 0.1, s: 0.28, r: 0.11 })
    const scream = syncsaw(note.freq, 2.45).mix(pulse(note.freq.mul(0.5), 0.38), 0.2)
    return svf(scream, bright, { res: 0.32 }).mul(env).mul(0.32)
  },
  ({ input, delay }) => input.add(delay(input, 0.122, 0.2)),
  { voices: 6 },
)

const ctx_release = synth(
  ({ note, gate, adsr, sine, tri }) => {
    const env = adsr(gate, { a: 0.003, d: 0.9, s: 0, r: 1.4 })
    const tone = sine(note.freq)
      .add(sine(note.freq.mul(2.003)).mul(0.42))
      .add(tri(note.freq.mul(4.01)).mul(0.16))
    return tone.mul(env).mul(0.5)
  },
  ({ input, reverb }) => input.mix(reverb(input, { roomSize: 0.92, damp: 0.3 }), 0.52),
  { voices: 8 },
)
`

const COMMON_PATTERNS = `
const ctxHarmony = chord('<Dm Bb C A>')
const ctxRoots = note('<d2 bb1 c2 a1>')
const ctxTheme = note('d5 a4 d5 f5 e5 d5 c#5 a4')
const ctxAnswer = note('f5 e5 d5 a4 bb4 c5 d5 e5')

p('ctx_pad', ctxHarmony.sound('ctx_pad').dur(0.98).gain(0.5))
p('ctx_theme', cat(ctxTheme, ctxAnswer).sound('ctx_piano').dur(0.72).gain(0.68))
`

const DRUMS_HALF = `
p('ctx_kick', note('c1 ~ ~ ~ c1 ~ ~ ~').sound('ctx_kick').gain(0.72))
`

const DRUMS_FULL = `
p('ctx_kick', note('c1*4').sound('ctx_kick').gain(0.78))
p('ctx_snare', note('~ c3 ~ c3').sound('ctx_snare').gain(0.64))
`

const BASS = `
p('ctx_bass', ctxRoots
  .struct(mini('t ~ t t ~ t t ~'))
  .sound('ctx_bass')
  .dur(0.42)
  .gain(0.62))
`

const HATS = `
p('ctx_hat', note('c6*8').sound('ctx_hat').gain(rand.range(0.42, 0.78)).degradeBy(0.08, 19))
`

const HATS_FAST = `
p('ctx_hat_fast', note('c7*16').sound('ctx_hat_fast').gain(rand.range(0.28, 0.7)).degradeBy(0.1, 29))
`

const ARP_SLOW = `
p('ctx_arp', ctxHarmony.arp('updown').fast(2).sound('ctx_arp').dur(0.34).gain(0.54))
`

const ARP_FAST = `
p('ctx_arp', ctxHarmony.arp('updowninc').fast(4).sound('ctx_arp').dur(0.22).gain(0.52))
`

const LEAD = `
p('ctx_lead', cat(
  note('d5 f5 a5 g5 f5 e5 d5 a4'),
  note('bb4 d5 f5 e5 d5 c#5 d5 a5'),
).sound('ctx_lead').dur(0.86).gain(0.5))
`

const LEAD_URGENT = `
p('ctx_lead', cat(
  note('d5 f5 a5 d6 c6 bb5 a5 g5'),
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

const MIX = `
sidechain('ctx_kick', {
  depth: 0.46,
  release: 0.11,
  duck: { ctx_bass: 0.34, ctx_pad: 0.62, ctx_piano: 0.18, ctx_lead: 0.24 },
})
masterCompress({ threshold: -10, ratio: 2.4, attack: 14, release: 105, knee: 5, makeup: 1 })
setCps(${CONTEXT_SCORE_CPS})
`

const normalPatterns = (zone: ContextZone): string => {
  const parts = [COMMON_PATTERNS, zone >= 2 ? DRUMS_FULL : DRUMS_HALF]
  if (zone >= 1) parts.push(BASS, HATS)
  if (zone >= 2) parts.push(ARP_SLOW, LEAD)
  if (zone >= 3) parts.push(HATS_FAST, COUNTER)
  if (zone >= 4) parts.push(ARP_FAST, LEAD_URGENT)
  if (zone >= 5) parts.push(LAST)
  return parts.join('\n')
}

const COMPACTING = `
p('ctx_compact_pad', chord('<A7 A7sus4 A7 A7>').sound('ctx_pad').dur(0.98).gain(0.42))
p('ctx_compact_fall', note('d6 c#6 bb5 a5 g5 f5 e5 d5').sound('ctx_piano').dur(0.7).gain(0.62))
p('ctx_compact_hold', note('a4@8').sound('ctx_lead').dur(1.2).gain(0.3))
`

const RELEASE = `
p('ctx_release_pad', chord('<Dm Dm Bb A>').sound('ctx_pad').dur(0.98).gain(0.38))
p('ctx_release_bells', note('d6 a5 f5 d5').sound('ctx_release').dur(0.9).gain(0.6))
p('ctx_release_theme', note('d5 ~ a4 ~ d5 f5 e5 d5').sound('ctx_piano').dur(0.75).gain(0.54))
`

export function danmakuContextScore(
  zone: ContextZone,
  mode: ContextScoreMode = 'normal',
): string {
  const patterns = mode === 'compacting' ? COMPACTING : mode === 'release' ? RELEASE : normalPatterns(zone)
  return `// RondoCode context score: original procedural danmaku composition.\n${SYNTHS}\n${patterns}\n${MIX}`
}

/** Default source used on first browser connection. */
export const DANMAKU_CONTEXT_SCORE = danmakuContextScore(0)
