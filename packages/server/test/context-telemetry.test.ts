import { describe, expect, it } from 'vitest'
import {
  ContextInputError,
  ContextPressureEngine,
  contextMix,
  directZone,
  hystereticZone,
  parseContextTelemetry,
  rawPressureOf,
} from '../src/context-telemetry'

describe('context telemetry parsing and pressure', () => {
  it('prefers token counts and subtracts the harness reserve', () => {
    expect(
      rawPressureOf({
        sessionId: 'x',
        rawPercent: 10,
        usedTokens: 90,
        contextWindow: 200,
        reserveTokens: 20,
      }),
    ).toBeCloseTo(0.5)
  })

  it('accepts a generic percentage and rejects malformed payloads', () => {
    expect(rawPressureOf(parseContextTelemetry({ sessionId: 'x', rawPercent: 72 }))).toBe(0.72)
    expect(() => parseContextTelemetry({ sessionId: '', rawPercent: 20 })).toThrow(ContextInputError)
    expect(() => parseContextTelemetry({ sessionId: 'x', event: 'panic' })).toThrow(ContextInputError)
  })

  it('uses narrower high-pressure zones with downward hysteresis', () => {
    expect(directZone(0.1)).toBe(0)
    expect(directZone(0.7)).toBe(3)
    expect(directZone(0.95)).toBe(5)
    expect(hystereticZone(3, 0.68, 0.04)).toBe(3)
    expect(hystereticZone(3, 0.65, 0.04)).toBe(2)
  })
})

describe('ContextPressureEngine', () => {
  it('tracks multiple sessions and gives explicit focus to the latest reporter', () => {
    let now = 1
    const engine = new ContextPressureEngine({ smoothing: 1, now: () => now++ })
    engine.ingest({ sessionId: 'a', source: 'pi', rawPercent: 20, focused: true })
    engine.ingest({ sessionId: 'b', source: 'omp', rawPercent: 80, focused: true })
    expect(engine.active?.sessionId).toBe('b')
    expect(engine.get('a')?.focused).toBe(false)
    expect(engine.states()).toHaveLength(2)
  })

  it('snaps down on compaction instead of slowly smearing the release', () => {
    const engine = new ContextPressureEngine({ smoothing: 0.1 })
    engine.ingest({ sessionId: 'x', rawPercent: 96, focused: true })
    const compacting = engine.ingest({ sessionId: 'x', event: 'compact-start' })!
    expect(compacting.compacting).toBe(true)
    const released = engine.ingest({ sessionId: 'x', event: 'compact-end', rawPercent: 18 })!
    expect(released.pressure).toBeCloseTo(0.18)
    expect(released.zone).toBe(0)
    expect(released.compacting).toBe(false)
    expect(released.release).toBe(true)
  })

  it('matches a terminal title by project folder', () => {
    const engine = new ContextPressureEngine({ smoothing: 1 })
    engine.ingest({ sessionId: 'one', cwd: '/work/alpha', rawPercent: 10 })
    engine.ingest({ sessionId: 'two', cwd: '/work/beta', rawPercent: 20 })
    expect(engine.matchTitle('beta — zsh')?.sessionId).toBe('two')
  })

  it('keeps focus on the foreground session when a background session reports without claiming focus', () => {
    let now = 1
    const engine = new ContextPressureEngine({ smoothing: 1, now: () => now++ })
    engine.ingest({ sessionId: 'foreground', rawPercent: 40, focused: true })
    expect(engine.activeSessionId).toBe('foreground')
    engine.ingest({ sessionId: 'background', rawPercent: 80 })
    expect(engine.activeSessionId).toBe('foreground')
    expect(engine.get('background')?.focused).toBe(false)
  })

  it('keeps the active session when several same-repo sessions match a title', () => {
    let now = 1
    const engine = new ContextPressureEngine({ smoothing: 1, now: () => now++ })
    engine.ingest({ sessionId: 'a', cwd: '/work/rondocode', rawPercent: 40, focused: true })
    engine.ingest({ sessionId: 'b', cwd: '/work/rondocode', rawPercent: 60 })
    expect(engine.matchTitle('rondocode — zsh')?.sessionId).toBe('a')
  })
})

describe('contextMix', () => {
  it('mutes every generated layer outside a coding window', () => {
    const engine = new ContextPressureEngine({ smoothing: 1 })
    const state = engine.ingest({ sessionId: 'x', rawPercent: 90, focused: true })!
    const mix = contextMix(state, false)
    expect(mix.params.length).toBeGreaterThan(0)
    expect(mix.channels.every((channel) => channel.gain === 0)).toBe(true)
  })

  it('reveals critical layers only in the critical zone', () => {
    const engine = new ContextPressureEngine({ smoothing: 1 })
    const low = contextMix(engine.ingest({ sessionId: 'x', rawPercent: 20 })!, true)
    const high = contextMix(engine.ingest({ sessionId: 'x', rawPercent: 98 })!, true)
    expect(low.channels.find((c) => c.synth === 'ctx_last')?.gain).toBe(0)
    expect(high.channels.find((c) => c.synth === 'ctx_last')?.gain).toBeGreaterThan(0)
  })
})
