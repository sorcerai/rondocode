import type { ContextTelemetry } from './context-telemetry'

export const DEFAULT_CONTEXT_URL =
  process.env['RONDOCODE_CONTEXT_URL'] ?? 'http://127.0.0.1:6070/context'

export interface PostContextOpts {
  url?: string
  timeoutMs?: number
}

export async function postContext(
  payload: ContextTelemetry,
  opts?: PostContextOpts,
): Promise<unknown> {
  const timeoutMs = opts?.timeoutMs ?? 1200
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(opts?.url ?? DEFAULT_CONTEXT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, ...payload }),
      signal: controller.signal,
    })
    const text = await response.text()
    let parsed: unknown
    if (text !== '') {
      try {
        parsed = JSON.parse(text) as unknown
      } catch {
        parsed = text
      }
    }
    if (!response.ok) {
      const detail =
        typeof parsed === 'object' &&
        parsed !== null &&
        'error' in parsed &&
        typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : `${response.status} ${response.statusText}`
      throw new Error(`rondocode context endpoint: ${detail}`)
    }
    return parsed
  } finally {
    clearTimeout(timer)
  }
}
