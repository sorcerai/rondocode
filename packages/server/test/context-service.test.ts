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
  it('loads the score once, then applies continuous updates without re-evaluating the zone', async () => {
    const { service, calls } = rig()
    await service.ingest({ sessionId: 's', source: 'pi', rawPercent: 20, focused: true })
    expect(calls.map((call) => call.method)).toEqual(['startContextScore', 'applyContext'])

    calls.length = 0
    await service.ingest({ sessionId: 's', source: 'pi', rawPercent: 28 })
    expect(calls.map((call) => call.method)).toEqual(['applyContext'])

    calls.length = 0
    await service.ingest({ sessionId: 's', source: 'pi', rawPercent: 72 })
    expect(calls.map((call) => call.method)).toEqual(['startContextScore', 'applyContext'])
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

  it('uses distinct compacting and release arrangements, then returns home', async () => {
    const { service, calls, timers, advance } = rig()
    await service.ingest({ sessionId: 's', rawPercent: 96, focused: true })

    calls.length = 0
    await service.ingest({ sessionId: 's', event: 'compact-start' })
    expect(service.status().scoreKey).toBe('compacting')

    calls.length = 0
    await service.ingest({ sessionId: 's', event: 'compact-end', rawPercent: 18 })
    expect(service.status().scoreKey).toBe('release')
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBe(1200)

    advance(1200)
    timers[0]!.fn()
    // Enqueue one more awaited sync behind the timer's fire-and-forget sync.
    await service.setForeground({ focused: true, app: 'Terminal', title: 's' })
    expect(service.status().scoreKey).toBe('normal:0')
    expect(service.status().active?.release).toBe(false)
  })

  it('keeps telemetry queued when the browser is not connected', async () => {
    const { service, calls } = rig(false)
    await expect(
      service.ingest({ sessionId: 's', rawPercent: 55, focused: true }),
    ).resolves.toBeDefined()
    expect(calls).toEqual([])
    expect(service.status().sessions).toHaveLength(1)
  })
})
