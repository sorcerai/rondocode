import { describe, expect, it } from 'vitest'
import { ContextService, type ContextBrowserBridge } from '../src/context-service'
import { ContextPressureEngine } from '../src/context-telemetry'

interface Call {
  method: string
  params: unknown
}

const rig = (connected = true) => {
  const calls: Call[] = []
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = []
  let now = 1000
  const bridge: ContextBrowserBridge = {
    connected,
    async call(method, params) {
      calls.push({ method, params })
      return method === 'startContextScore' ? { ok: true, diagnostics: [] } : {}
    },
  }
  const service = new ContextService({
    getBridge: () => bridge,
    engine: new ContextPressureEngine({ smoothing: 1, now: () => now }),
    now: () => now,
    releaseMs: 1200,
    setTimeoutImpl: (fn, ms) => {
      const timer = { fn, ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeoutImpl: (handle) => {
      ;(handle as { cleared: boolean }).cleared = true
    },
  })
  return {
    bridge,
    calls,
    timers,
    service,
    advance(ms: number) {
      now += ms
    },
  }
}

describe('ContextService', () => {
  it('replaces the score only when pressure crosses a zone boundary', async () => {
    const { service, calls } = rig()
    await service.ingest({ sessionId: 's', source: 'pi', rawPercent: 20, focused: true })
    const initial = calls.find((call) => call.method === 'startContextScore')!
    const initialSource = (initial.params as { source: string }).source
    expect(calls.map((call) => call.method)).toEqual(['startContextScore', 'applyContext'])

    calls.length = 0
    await service.ingest({ sessionId: 's', source: 'pi', rawPercent: 22 })
    expect(calls.map((call) => call.method)).toEqual(['applyContext'])

    calls.length = 0
    await service.ingest({ sessionId: 's', source: 'pi', rawPercent: 72 })
    const changed = calls.find((call) => call.method === 'startContextScore')!
    const changedSource = (changed.params as { source: string }).source
    expect(calls.map((call) => call.method)).toEqual(['startContextScore', 'applyContext'])
    expect(changedSource).not.toBe(initialSource)
    expect(changedSource).toContain("p('ctx_ghost'")
  })

  it('mutes all score channels when the foreground watcher leaves a coding app', async () => {
    const { service, calls } = rig()
    await service.ingest({ sessionId: 's', rawPercent: 80, focused: true })
    calls.length = 0
    await service.setForeground({ focused: false, app: 'Safari', title: 'inbox' })
    const apply = calls.find((call) => call.method === 'applyContext')!
    const channels = (apply.params as { channels: { gain?: number }[] }).channels
    expect(channels.every((channel) => channel.gain === 0)).toBe(true)
  })

  it('does not auto-select a brand-new session that explicitly reports blur', async () => {
    const { service, calls } = rig()
    const state = await service.ingest({
      sessionId: 's',
      event: 'focus',
      rawPercent: 40,
      focused: false,
    })

    expect(state?.focused).toBe(false)
    expect(service.status().active).toBeUndefined()
    expect(calls).toEqual([])
  })

  it('honors an explicit session blur instead of reviving it by recency', async () => {
    const { service, calls } = rig()
    await service.ingest({ sessionId: 's', rawPercent: 70, focused: true })
    calls.length = 0

    await service.ingest({ sessionId: 's', event: 'focus', focused: false })

    expect(service.status().active).toBeUndefined()
    const apply = calls.find((call) => call.method === 'applyContext')!
    const channels = (apply.params as { channels: { gain?: number }[] }).channels
    expect(channels.every((channel) => channel.gain === 0)).toBe(true)
  })

  it('mutes when the active session ends instead of guessing a background replacement', async () => {
    const { service, calls } = rig()
    await service.ingest({ sessionId: 'active', rawPercent: 78, focused: true })
    await service.ingest({ sessionId: 'background', rawPercent: 42 })
    calls.length = 0

    await service.ingest({ sessionId: 'active', event: 'session-end' })

    expect(service.status().active).toBeUndefined()
    expect(service.status().sessions.map((state) => state.sessionId)).toEqual(['background'])
    const apply = calls.find((call) => call.method === 'applyContext')!
    const channels = (apply.params as { channels: { gain?: number }[] }).channels
    expect(channels.every((channel) => channel.gain === 0)).toBe(true)
  })

  it('does not let a background compaction hijack the active score transition', async () => {
    const { service, calls, timers } = rig()
    await service.ingest({ sessionId: 'active', rawPercent: 20, focused: true })
    await service.ingest({ sessionId: 'background', rawPercent: 92 })
    calls.length = 0

    await service.ingest({ sessionId: 'background', event: 'compact-end', rawPercent: 18 })

    expect(service.status().active?.sessionId).toBe('active')
    expect(service.status().scoreKey).toBe('normal:2')
    expect(service.status().releaseSessionId).toBeUndefined()
    expect(timers).toHaveLength(0)
    expect(calls.map((call) => call.method)).toEqual(['applyContext'])
  })

  it('uses distinct compacting and release arrangements, then returns home', async () => {
    const { service, calls, timers, advance } = rig()
    await service.ingest({ sessionId: 's', rawPercent: 96, focused: true })

    calls.length = 0
    await service.ingest({ sessionId: 's', event: 'compact-start' })
    expect(service.status().scoreKey).toBe('compacting')

    calls.length = 0
    await service.ingest({ sessionId: 's', event: 'compact-end', rawPercent: 3 })
    expect(service.status().scoreKey).toBe('release')
    expect(service.status().releaseSessionId).toBe('s')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(1200)

    advance(1200)
    timers[0]!.fn()
    // Enqueue one more awaited sync behind the timer's fire-and-forget sync.
    await service.setForeground({ focused: true, app: 'Terminal', title: 's' })
    expect(service.status().scoreKey).toBe('normal:0')
    expect(service.status().active?.release).toBe(false)
    expect(service.status().releaseSessionId).toBeUndefined()
  })

  it('keeps telemetry queued when the browser is not connected', async () => {
    const { service, calls } = rig(false)
    await expect(
      service.ingest({ sessionId: 's', rawPercent: 55, focused: true }),
    ).resolves.toBeDefined()
    expect(calls).toEqual([])
    expect(service.status().sessions).toHaveLength(1)
  })

  it('mutes every channel when music is disabled, even with foreground allowed', async () => {
    const { service, calls } = rig()
    await service.ingest({ sessionId: 's', rawPercent: 80, focused: true })
    expect(service.status().music.enabled).toBe(true)

    calls.length = 0
    await service.setMusicEnabled(false)

    const apply = calls.find((call) => call.method === 'applyContext')!
    const channels = (apply.params as { channels: { gain?: number }[] }).channels
    expect(channels.every((channel) => channel.gain === 0)).toBe(true)
    expect(service.status().music.enabled).toBe(false)
  })

  it('restores audible channels when music is re-enabled with foreground allowed', async () => {
    const { service, calls } = rig()
    await service.ingest({ sessionId: 's', rawPercent: 80, focused: true })
    await service.setMusicEnabled(false)
    calls.length = 0

    await service.setMusicEnabled(true)

    const apply = calls.find((call) => call.method === 'applyContext')!
    const channels = (apply.params as { channels: { gain?: number }[] }).channels
    expect(channels.some((channel) => (channel.gain ?? 0) > 0)).toBe(true)
    expect(service.status().music.enabled).toBe(true)
  })

  it('toggleMusicEnabled flips the flag and returns the new value', async () => {
    const { service } = rig()
    expect(service.status().music.enabled).toBe(true)

    const afterFirst = await service.toggleMusicEnabled()
    expect(afterFirst).toBe(false)
    expect(service.status().music.enabled).toBe(false)

    const afterSecond = await service.toggleMusicEnabled()
    expect(afterSecond).toBe(true)
    expect(service.status().music.enabled).toBe(true)
  })
})
