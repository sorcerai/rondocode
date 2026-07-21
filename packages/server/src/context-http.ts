import type { IncomingMessage, ServerResponse } from 'node:http'
import { ContextUnavailableError, type ContextService } from './context-service'
import { ContextInputError, parseContextTelemetry } from './context-telemetry'

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
}

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json', ...CORS })
  res.end(JSON.stringify(body))
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let data = ''
    let rejected = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      if (rejected) return
      data += chunk
      if (data.length > 64_000) {
        rejected = true
        reject(new ContextInputError('context payload is too large'))
      }
    })
    req.on('end', () => {
      if (!rejected) resolve(data)
    })
    req.on('error', reject)
  })

/**
 * Local telemetry HTTP surface.
 *
 * POST /context        normalised harness event
 * POST /context/focus  foreground-app/window gate
 * GET  /context/status browser/session state
 */
export function makeContextHandler(
  service: ContextService,
): (req: IncomingMessage, res: ServerResponse) => boolean {
  return (req, res) => {
    const path = (req.url ?? '').split('?')[0]
    if (path !== '/context' && path !== '/context/status' && path !== '/context/focus') {
      return false
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS)
      res.end()
      return true
    }

    if (path === '/context/status' && req.method === 'GET') {
      sendJson(res, 200, service.status())
      return true
    }

    if (path === '/context/focus' && req.method === 'POST') {
      void readBody(req)
        .then((body) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(body)
          } catch {
            throw new ContextInputError('focus payload must be valid JSON')
          }
          if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
            throw new ContextInputError('focus payload must be a JSON object')
          }
          const value = parsed as Record<string, unknown>
          if (typeof value.focused !== 'boolean') {
            throw new ContextInputError('focused must be a boolean')
          }
          if (value.title !== undefined && typeof value.title !== 'string') {
            throw new ContextInputError('title must be a string')
          }
          if (value.app !== undefined && typeof value.app !== 'string') {
            throw new ContextInputError('app must be a string')
          }
          return service.setForeground({
            focused: value.focused,
            ...(typeof value.title === 'string' ? { title: value.title } : {}),
            ...(typeof value.app === 'string' ? { app: value.app } : {}),
          })
        })
        .then(() => sendJson(res, 200, { ok: true, status: service.status() }))
        .catch((error: unknown) => {
          if (error instanceof ContextInputError) {
            sendJson(res, 400, { ok: false, error: error.message })
            return
          }
          if (error instanceof ContextUnavailableError) {
            sendJson(res, 503, { ok: false, error: error.message, status: service.status() })
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          sendJson(res, 500, { ok: false, error: message })
        })
      return true
    }

    if (path === '/context' && req.method === 'POST') {
      void readBody(req)
        .then((body) => {
          let parsed: unknown
          try {
            parsed = JSON.parse(body)
          } catch {
            throw new ContextInputError('context payload must be valid JSON')
          }
          return service.ingest(parseContextTelemetry(parsed))
        })
        .then((state) => sendJson(res, 200, { ok: true, state, status: service.status() }))
        .catch((error: unknown) => {
          if (error instanceof ContextInputError) {
            sendJson(res, 400, { ok: false, error: error.message })
            return
          }
          if (error instanceof ContextUnavailableError) {
            sendJson(res, 503, { ok: false, error: error.message, status: service.status() })
            return
          }
          const message = error instanceof Error ? error.message : String(error)
          console.error('[context] telemetry failed:', message)
          sendJson(res, 500, { ok: false, error: message })
        })
      return true
    }

    res.writeHead(405, CORS)
    res.end()
    return true
  }
}
