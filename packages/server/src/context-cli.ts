#!/usr/bin/env node
import { postContext } from './context-client'
import { parseContextTelemetry, type ContextTelemetry } from './context-telemetry'

const HELP = `rondocode context telemetry

Pipe a normalized JSON object:
  echo '{"source":"demo","sessionId":"s1","rawPercent":72,"focused":true}' | pnpm context

Or use flags:
  pnpm context -- --source demo --session s1 --percent 72 --focused
  pnpm context -- --source demo --session s1 --event compact-start
  pnpm context -- --source demo --session s1 --event compact-end --percent 24

Flags:
  --source NAME
  --model NAME
  --session ID
  --percent 0..100
  --used TOKENS
  --limit TOKENS
  --effective-limit TOKENS
  --reserve TOKENS
  --event usage|compact-start|compact-end|focus|session-end
  --focused | --blurred
  --cwd PATH
  --url http://127.0.0.1:6070/context
  --help
`

const readStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) return ''
  process.stdin.setEncoding('utf8')
  let data = ''
  for await (const chunk of process.stdin) data += chunk
  return data
}

const requireValue = (args: string[], index: number, flag: string): string => {
  const value = args[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

const asNumber = (value: string, flag: string): number => {
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`${flag} must be a finite number`)
  return n
}

const fromFlags = (args: string[]): { payload: ContextTelemetry; url?: string } => {
  const payload: Partial<ContextTelemetry> = { event: 'usage' }
  let url: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    switch (arg) {
      case '--source':
        payload.source = requireValue(args, i, arg)
        i++
        break
      case '--model':
        payload.model = requireValue(args, i, arg)
        i++
        break
      case '--session':
        payload.sessionId = requireValue(args, i, arg)
        i++
        break
      case '--percent':
        payload.rawPercent = asNumber(requireValue(args, i, arg), arg)
        i++
        break
      case '--used':
        payload.usedTokens = asNumber(requireValue(args, i, arg), arg)
        i++
        break
      case '--limit':
        payload.contextWindow = asNumber(requireValue(args, i, arg), arg)
        i++
        break
      case '--effective-limit':
        payload.effectiveLimitTokens = asNumber(requireValue(args, i, arg), arg)
        i++
        break
      case '--reserve':
        payload.reserveTokens = asNumber(requireValue(args, i, arg), arg)
        i++
        break
      case '--event':
        payload.event = requireValue(args, i, arg) as ContextTelemetry['event']
        i++
        break
      case '--focused':
        payload.focused = true
        break
      case '--blurred':
        payload.focused = false
        break
      case '--cwd':
        payload.cwd = requireValue(args, i, arg)
        i++
        break
      case '--url':
        url = requireValue(args, i, arg)
        i++
        break
      case '--help':
      case '-h':
        process.stdout.write(HELP)
        process.exit(0)
      default:
        throw new Error(`unknown flag: ${arg}`)
    }
  }
  return { payload: parseContextTelemetry(payload), ...(url !== undefined ? { url } : {}) }
}

const main = async (): Promise<void> => {
  const stdin = (await readStdin()).trim()
  let payload: ContextTelemetry
  let url: string | undefined

  if (stdin !== '') {
    payload = parseContextTelemetry(JSON.parse(stdin) as unknown)
  } else {
    const parsed = fromFlags(process.argv.slice(2))
    payload = parsed.payload
    url = parsed.url
  }

  const response = await postContext(payload, { ...(url !== undefined ? { url } : {}) })
  process.stdout.write(`${JSON.stringify(response, null, 2)}\n`)
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`rondocode context: ${message}\n`)
  process.exitCode = 1
})
