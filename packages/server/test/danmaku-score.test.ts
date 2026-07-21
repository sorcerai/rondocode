import { describe, expect, it } from 'vitest'
import { F, TimeSpan, hasOnset } from '@rondocode/pattern'
import { evalCode } from '../../app/src/session/evalCode'
import { baseScope } from '../../app/src/session/scope'
import {
  CONTEXT_SCORE_SYNTHS,
  danmakuContextScore,
  type ContextScoreMode,
} from '../src/danmaku-score'
import type { ContextZone } from '../src/context-telemetry'

const evaluate = (zone: ContextZone, mode: ContextScoreMode = 'normal') =>
  evalCode(danmakuContextScore(zone, mode), baseScope)

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

  it('keeps synth graphs stable while pressure only rearranges patterns', () => {
    const low = evaluate(0)
    const high = evaluate(5)
    for (const name of CONTEXT_SCORE_SYNTHS) {
      expect(JSON.stringify(high.synths.get(name))).toBe(JSON.stringify(low.synths.get(name)))
    }
    expect(high.patterns.size).toBeGreaterThan(low.patterns.size)
  })
})
