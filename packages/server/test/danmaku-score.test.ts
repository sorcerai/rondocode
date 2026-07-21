import { describe, expect, it } from 'vitest'
import { F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { evalCode } from '../../app/src/session/evalCode'
import { baseScope } from '../../app/src/session/scope'
import {
  CONTEXT_SCORE_CPS,
  CONTEXT_SCORE_SYNTHS,
  danmakuContextScore,
  type ContextScoreMode,
} from '../src/danmaku-score'
import type { ContextZone } from '../src/context-telemetry'

const evaluate = (zone: ContextZone, mode: ContextScoreMode = 'normal') =>
  evalCode(danmakuContextScore(zone, mode), baseScope)

const eventsFor = (zone: ContextZone, name: string) => {
  const pattern = evaluate(zone).patterns.get(name)
  expect(pattern, `pattern '${name}'`).toBeDefined()
  return pattern!.query(new TimeSpan(F(0), F(1))).filter(hasOnset)
}

const onsetsFor = (zone: ContextZone, name: string) =>
  eventsFor(zone, name).map((hap) => hap.whole!.begin.valueOf())

const patternNamesFor = (zone: ContextZone) => [...evaluate(zone).patterns.keys()].sort()

const registrationsFor = (zone: ContextZone) =>
  [...danmakuContextScore(zone).matchAll(/p\('([^']+)'/g)].map(([, name]) => name!)

describe('procedural danmaku context score', () => {
  for (let zone = 0; zone <= 5; zone++) {
    it(`zone ${zone} evaluates and every registered pattern produces sound`, () => {
      const result = evaluate(zone as ContextZone)
      expect(result.ok).toBe(true)
      expect(result.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
      expect([...result.synths.keys()].sort()).toEqual([...CONTEXT_SCORE_SYNTHS].sort())
      const span = new TimeSpan(F(0), F(2))
      for (const [name, pattern] of result.patterns) {
        const sounding = pattern
          .query(span)
          .filter(hasOnset)
          .filter(
            (hap) =>
              typeof hap.value.note === 'number' &&
              typeof hap.value.sound === 'string' &&
              result.synths.has(hap.value.sound),
          )
        expect(sounding.length, `pattern '${name}'`).toBeGreaterThan(0)
      }
    })
  }

  for (const mode of ['compacting', 'release'] as const) {
    it(`${mode} transition is fully synthesized and playable`, () => {
      const source = danmakuContextScore(5, mode)
      expect(source).not.toContain('.sample(')
      const result = evaluate(5, mode)
      expect(result.ok).toBe(true)
      expect(result.patterns.size).toBeGreaterThan(0)
    })
  }

  it('turns critical pressure into a swung liquid two-step arrangement', () => {
    expect(CONTEXT_SCORE_CPS).toBe(174 / 240)
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

  it('uses the exact layer ladder without duplicate pattern registrations', () => {
    const expected = [
      ['ctx_pad', 'ctx_theme'],
      ['ctx_bass', 'ctx_flow_hat', 'ctx_pad', 'ctx_theme'],
      ['ctx_arp', 'ctx_bass', 'ctx_hat', 'ctx_kick', 'ctx_lead', 'ctx_pad', 'ctx_snare', 'ctx_theme'],
      [
        'ctx_arp',
        'ctx_bass',
        'ctx_counter',
        'ctx_ghost',
        'ctx_hat',
        'ctx_hat_fast',
        'ctx_kick',
        'ctx_lead',
        'ctx_pad',
        'ctx_snare',
        'ctx_theme',
      ],
      [
        'ctx_arp',
        'ctx_bass',
        'ctx_counter',
        'ctx_ghost',
        'ctx_hat',
        'ctx_hat_fast',
        'ctx_kick',
        'ctx_lead',
        'ctx_pad',
        'ctx_snare',
        'ctx_theme',
      ],
      [
        'ctx_arp',
        'ctx_bass',
        'ctx_counter',
        'ctx_fill',
        'ctx_ghost',
        'ctx_hat',
        'ctx_hat_fast',
        'ctx_kick',
        'ctx_last',
        'ctx_lead',
        'ctx_pad',
        'ctx_snare',
        'ctx_theme',
      ],
    ]

    for (const [zone, names] of expected.entries()) {
      const typedZone = zone as ContextZone
      expect(patternNamesFor(typedZone)).toEqual(names)
      const registrations = registrationsFor(typedZone)
      expect(new Set(registrations).size).toBe(registrations.length)
    }
  })

  it('replaces upper-zone harmony and melodic motion', () => {
    const buildSource = danmakuContextScore(3)
    const urgentSource = danmakuContextScore(4)
    expect(buildSource).toContain("const ctxHarmony = chord('<Dm9 Bbmaj7 Fadd9 A7>')")
    expect(urgentSource).toContain("const ctxHarmony = chord('<Dm9 Gm9 Bbmaj7 A7>')")
    expect(urgentSource).toContain("note('d5 a5 c6 d6 c6 a5 g5 f5')")
    expect(urgentSource).not.toContain("note('bb4 d5 f5 a5 g5 f5 e5 c#5')")
  })

  it('keeps synth graphs stable while pressure only rearranges patterns', () => {
    const low = evaluate(0)
    const high = evaluate(5)
    for (const name of CONTEXT_SCORE_SYNTHS) {
      expect(JSON.stringify(high.synths.get(name))).toBe(JSON.stringify(low.synths.get(name)))
    }
    expect(high.patterns.size).toBeGreaterThan(low.patterns.size)
  })
})
