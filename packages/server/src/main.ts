/* CLI entry: run the local browser bridge, context telemetry service, and
 * optional ghost-text completion endpoint (root script `pnpm bridge`). */
import { Bridge } from './bridge'
import { CompletionService, makeCompleteHandler } from './complete'
import { makeContextHandler } from './context-http'
import { ContextService } from './context-service'

const port = Number(process.env.PORT ?? 6070)
const completion = new CompletionService()
const completeHandler = makeCompleteHandler(completion)

let bridge: Bridge
const context = new ContextService({ getBridge: () => bridge })
const contextHandler = makeContextHandler(context)

bridge = new Bridge({
  port,
  httpHandler: (req, res) => contextHandler(req, res) || completeHandler(req, res),
})

console.log(
  `[bridge] ghost-text completion ${completion.available ? 'enabled' : 'disabled (no ANTHROPIC_API_KEY)'}`,
)
console.log('[bridge] context telemetry POST /context; status GET /context/status')

bridge.onNotify = (kind, payload) => {
  if (kind === 'hello') {
    void context.browserHello().catch((error: unknown) => {
      console.error(
        '[context] browser sync failed:',
        error instanceof Error ? error.message : error,
      )
    })
  }
  console.log(`[bridge] notify ${kind}:`, JSON.stringify(payload))
}

await bridge.listen()
console.log(`bridge listening :${bridge.port}`)

let stopFocusWatcher: (() => void) | undefined
if (
  process.env['RONDOCODE_FOCUS_WATCHER'] !== '0' &&
  (process.platform === 'darwin' || process.platform === 'linux')
) {
  const { startFocusWatcher } = await import('../adapters/focus-watcher')
  const watcher = startFocusWatcher()
  stopFocusWatcher = () => watcher.stop()
}

process.on('SIGINT', () => {
  console.log('\n[bridge] shutting down')
  stopFocusWatcher?.()
  void bridge.close().then(() => process.exit(0))
})
