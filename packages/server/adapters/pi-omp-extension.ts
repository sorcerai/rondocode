/*
 * Drop-in Pi / OMP extension for RondoCode context sonification.
 *
 * This file is intentionally self-contained so it can be copied into either
 * harness's extensions directory without importing the RondoCode monorepo.
 */

type Usage = { tokens: number; contextWindow: number; percent: number }
type Event = { type?: string }
type ExtensionContext = {
  cwd: string
  model?: { id?: string }
  getContextUsage(): Usage | undefined
  sessionManager: { getSessionFile(): string | undefined }
}
type Handler = (event: Event, ctx: ExtensionContext) => unknown | Promise<unknown>
type ExtensionAPI = {
  on(name: string, handler: Handler): void
  logger?: { debug(message: string, details?: unknown): void }
}

const endpoint =
  process.env['RONDOCODE_CONTEXT_URL'] ?? 'http://127.0.0.1:6070/context'
const reserveTokens = Number(process.env['RONDOCODE_RESERVE_TOKENS'] ?? 16_384)
const source =
  process.env['RONDOCODE_SOURCE'] ??
  (process.env['PI_CODING_AGENT_DIR']?.toLowerCase().includes('.omp') === true ||
  process.argv.some((part) => part.toLowerCase().includes('omp'))
    ? 'omp'
    : 'pi')

const sessionId = (ctx: ExtensionContext): string =>
  ctx.sessionManager.getSessionFile() ?? `${ctx.cwd}:${process.pid}`

const post = async (body: Record<string, unknown>): Promise<void> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 650)
  try {
    await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: 1, source, ...body }),
      signal: controller.signal,
    })
  } catch {
    // The coding harness must remain boringly functional when RondoCode is off.
  } finally {
    clearTimeout(timer)
  }
}

const usageBody = (ctx: ExtensionContext): Record<string, unknown> => {
  const usage = ctx.getContextUsage()
  const body: Record<string, unknown> = {
    sessionId: sessionId(ctx),
    event: 'usage',
    cwd: ctx.cwd,
    focused: true,
  }
  if (ctx.model?.id !== undefined) body['model'] = ctx.model.id
  if (usage !== undefined) {
    body['usedTokens'] = usage.tokens
    body['contextWindow'] = usage.contextWindow
    body['rawPercent'] = usage.percent
    if (Number.isFinite(reserveTokens) && reserveTokens >= 0) {
      body['reserveTokens'] = reserveTokens
    }
  }
  return body
}

export default function rondocodeContext(pi: ExtensionAPI): void {
  const reportUsage: Handler = async (_event, ctx) => post(usageBody(ctx))

  pi.on('session_start', reportUsage)
  pi.on('input', reportUsage)
  pi.on('agent_end', reportUsage)

  pi.on('session_before_compact', async (_event, ctx) => {
    await post({
      ...usageBody(ctx),
      event: 'compact-start',
    })
  })

  pi.on('session_compact', async (_event, ctx) => {
    await post({
      ...usageBody(ctx),
      event: 'compact-end',
    })
  })

  pi.on('session_shutdown', async (_event, ctx) => {
    await post({
      sessionId: sessionId(ctx),
      event: 'session-end',
      cwd: ctx.cwd,
    })
  })

  pi.logger?.debug('RondoCode context sonification extension loaded', {
    source,
    endpoint,
  })
}
