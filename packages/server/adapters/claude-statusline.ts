#!/usr/bin/env node
import { basename } from 'node:path'
import { postContext } from '../src/context-client'
import type { ContextTelemetry } from '../src/context-telemetry'

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

const firstNumber = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return undefined
}

const firstString = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

const main = async (): Promise<void> => {
  const raw = await readStdin()
  let input: Json = {}
  try {
    input = obj(JSON.parse(raw))
  } catch {
    process.stdout.write('♪ context ?')
    return
  }

  const context = obj(input['context_window'])
  const workspace = obj(input['workspace'])
  const modelObj = obj(input['model'])
  const cwd = firstString(input['cwd'], workspace['current_dir'], workspace['project_dir'])
  const sessionId =
    firstString(input['session_id'], input['sessionId']) ??
    `${cwd ?? 'claude'}:${process.ppid}`
  const rawPercent = firstNumber(
    context['used_percentage'],
    context['usedPercent'],
    input['used_percentage'],
  )
  const contextWindow = firstNumber(
    context['context_window_size'],
    context['contextWindowSize'],
    context['limit_tokens'],
  )
  const usedTokens = firstNumber(
    context['used_tokens'],
    context['usedTokens'],
    input['used_tokens'],
  )
  const model = firstString(
    modelObj['display_name'],
    modelObj['id'],
    input['model_name'],
  )

  const payload: ContextTelemetry = {
    source: 'claude-code',
    sessionId,
    event: 'usage',
    focused: true,
  }
  // Claude's precomputed percentage already accounts for its own context
  // semantics. Do not send a token estimate alongside it, because the shared
  // normalizer intentionally prefers token counts for Pi/OMP reserve handling.
  if (rawPercent !== undefined) {
    payload.rawPercent = rawPercent
    if (contextWindow !== undefined) payload.contextWindow = contextWindow
  } else {
    if (contextWindow !== undefined) payload.contextWindow = contextWindow
    if (usedTokens !== undefined) payload.usedTokens = usedTokens
  }
  if (model !== undefined) payload.model = model
  if (cwd !== undefined) payload.cwd = cwd

  // Status-line output must never disappear because the local music bridge is
  // offline. Send telemetry opportunistically, then render useful text anyway.
  try {
    await postContext(payload, { timeoutMs: 500 })
  } catch {
    // Deliberately silent: Claude should not flash adapter failures at the user.
  }

  const calculatedPercent =
    rawPercent ??
    (usedTokens !== undefined && contextWindow !== undefined && contextWindow > 0
      ? (usedTokens / contextWindow) * 100
      : undefined)
  const percentText =
    calculatedPercent === undefined ? '?' : `${Math.round(calculatedPercent)}%`
  const project = cwd === undefined ? undefined : basename(cwd)
  const details = [percentText, model, project].filter(
    (value): value is string => value !== undefined,
  )
  process.stdout.write(`♪ ${details.join(' · ')}`)
}

void main().catch(() => {
  process.stdout.write('♪ context ?')
})
