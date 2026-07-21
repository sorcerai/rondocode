#!/usr/bin/env node
import { postContext } from '../src/context-client'
import type { ContextEvent, ContextTelemetry } from '../src/context-telemetry'

type Json = Record<string, unknown>

const obj = (value: unknown): Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {}

const readStdin = async (): Promise<string> => {
  process.stdin.setEncoding('utf8')
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data
}

const eventOf = (name: string): ContextEvent | undefined => {
  const key = name.toLowerCase().replace(/[^a-z]/g, '')
  if (key.includes('precompact')) return 'compact-start'
  if (key.includes('postcompact')) return 'compact-end'
  if (key.includes('sessionend') || key.includes('sessionstop')) return 'session-end'
  return undefined
}

const main = async (): Promise<void> => {
  let input: Json = {}
  try {
    input = obj(JSON.parse(await readStdin()))
  } catch {
    return
  }

  const hookName =
    (typeof input['hook_event_name'] === 'string' ? input['hook_event_name'] : undefined) ??
    process.env['CLAUDE_HOOK_EVENT_NAME'] ??
    ''
  const event = eventOf(hookName)
  if (event === undefined) return

  const cwd = typeof input['cwd'] === 'string' ? input['cwd'] : process.cwd()
  const sessionId =
    typeof input['session_id'] === 'string'
      ? input['session_id']
      : `${cwd}:${process.ppid}`
  const payload: ContextTelemetry = {
    source: 'claude-code',
    sessionId,
    event,
    cwd,
  }
  if (event !== 'session-end') payload.focused = true

  try {
    await postContext(payload, { timeoutMs: 900 })
  } catch {
    // Hooks are observability, never a reason to block compaction or shutdown.
  }
}

void main()
