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
type NotifyLevel = 'info' | 'warn' | 'error'
type CommandContext = { ui: { notify(message: string, level?: NotifyLevel): void } }
type CommandHandler = (rawArgs: string, ctx: CommandContext) => unknown | Promise<unknown>
type Command = { description: string; handler: CommandHandler }
type ExtensionAPI = {
  on(name: string, handler: Handler): void
  registerCommand?(name: string, command: Command): void
  logger?: { debug(message: string, details?: unknown): void }
}

const endpoint =
  process.env['RONDOCODE_CONTEXT_URL'] ?? 'http://127.0.0.1:6070/context'
const base = endpoint.replace(/\/context\/?$/, '')
const musicUrl = `${base}/context/music`
const statusUrl = `${base}/context/status`
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

const postJson = async (
  url: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown> | undefined> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1200)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    if (!res.ok) return undefined
    return (await res.json()) as Record<string, unknown>
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

const getStatus = async (): Promise<Record<string, unknown> | undefined> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1200)
  try {
    const res = await fetch(statusUrl, { signal: controller.signal })
    if (!res.ok) return undefined
    return (await res.json()) as Record<string, unknown>
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

const usageBody = (ctx: ExtensionContext, claimFocus = false): Record<string, unknown> => {
  const usage = ctx.getContextUsage()
  const body: Record<string, unknown> = {
    sessionId: sessionId(ctx),
    event: 'usage',
    cwd: ctx.cwd,
  }
  if (claimFocus) body['focused'] = true
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
  // Only a real user interaction claims the foreground. Background lifecycle
  // events (agent completion, compaction) update pressure without stealing
  // focus from the terminal the user is actively typing in, so several
  // terminals in the same repo disambiguate by input recency, not by whichever
  // agent last emitted telemetry.
  const reportUsage: Handler = async (_event, ctx) => post(usageBody(ctx, false))

  pi.on('session_start', reportUsage)
  pi.on('input', async (_event, ctx) => post(usageBody(ctx, true)))
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

  pi.registerCommand?.('music', {
    description:
      'Turn RondoCode context sonification on/off. Usage: /music [on|off|toggle|status]',
    handler: async (rawArgs, ctx) => {
      const arg = (typeof rawArgs === 'string' ? rawArgs : '').trim().toLowerCase()
      if (arg === 'status' || arg === '?') {
        const st = await getStatus()
        if (st === undefined) {
          ctx.ui.notify('RondoCode bridge not running — start it with `pnpm bridge`', 'warn')
          return
        }
        const music: unknown = st['music']
        const on =
          typeof music === 'object' &&
          music !== null &&
          'enabled' in music &&
          music.enabled === true
        ctx.ui.notify(`Context music is ${on ? 'ON' : 'OFF'}`, 'info')
        return
      }
      if (arg !== '' && arg !== 'on' && arg !== 'off' && arg !== 'toggle') {
        ctx.ui.notify('Usage: /music [on|off|toggle|status]', 'warn')
        return
      }
      const body = arg === 'on' ? { enabled: true } : arg === 'off' ? { enabled: false } : {}
      const res = await postJson(musicUrl, body)
      if (res === undefined) {
        ctx.ui.notify('RondoCode bridge not running — start it with `pnpm bridge`', 'warn')
        return
      }
      const on = res['enabled'] === true
      ctx.ui.notify(`Context music ${on ? 'on' : 'off'}`, 'info')
    },
  })

  pi.logger?.debug('RondoCode context sonification extension loaded', {
    source,
    endpoint,
  })
}
