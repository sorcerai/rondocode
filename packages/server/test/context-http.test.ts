import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { makeContextHandler } from '../src/context-http'
import { ContextService, type ContextBrowserBridge } from '../src/context-service'

const openServers: ReturnType<typeof createServer>[] = []

const rig = async (): Promise<string> => {
  const bridge: ContextBrowserBridge = {
    connected: false,
    async call() {
      throw new Error('not connected')
    },
  }
  const service = new ContextService({ getBridge: () => bridge })
  const handler = makeContextHandler(service)
  const server = createServer((req, res) => {
    if (handler(req, res)) return
    res.writeHead(404)
    res.end()
  })
  openServers.push(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address() as AddressInfo
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        }),
    ),
  )
})

describe('context HTTP surface', () => {
  it('keeps status private from arbitrary browser origins', async () => {
    const base = await rig()
    const response = await fetch(`${base}/context/status`)
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
    expect(response.headers.get('cache-control')).toBe('no-store')
    const body = (await response.json()) as { sessions: unknown[] }
    expect(body.sessions).toEqual([])
  })

  it('rejects simple-request content types before parsing a POST', async () => {
    const base = await rig()
    const response = await fetch(`${base}/context`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ sessionId: 'x', rawPercent: 50 }),
    })
    expect(response.status).toBe(415)
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: 'content-type must be application/json',
    })
  })

  it('accepts normalized JSON telemetry while the browser is offline', async () => {
    const base = await rig()
    const response = await fetch(`${base}/context`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ sessionId: 'x', source: 'demo', rawPercent: 72, focused: true }),
    })
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      ok: boolean
      state: { sessionId: string; pressure: number }
    }
    expect(body.ok).toBe(true)
    expect(body.state.sessionId).toBe('x')
    expect(body.state.pressure).toBeCloseTo(0.72)
  })
})
