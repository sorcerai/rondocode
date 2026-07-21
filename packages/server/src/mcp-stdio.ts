/* Stdio entry: ONE process runs the MCP server, browser bridge, context
 * telemetry HTTP surface, and foreground watcher. Launched by the repo-root
 * .mcp.json.
 *
 * STDOUT DISCIPLINE: the stdio transport owns stdout — every frame written
 * there must be MCP JSON-RPC. All logging goes to STDERR (console.error /
 * console.warn; the Bridge itself only console.warn's). Never console.log
 * in anything this file imports at runtime. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { Bridge } from './bridge'
import { CompletionService, makeCompleteHandler } from './complete'
import { makeContextHandler } from './context-http'
import { ContextService } from './context-service'
import { createMcpServer } from './mcp'

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

const server = createMcpServer(bridge)
// createMcpServer owns the bridge's notification cache listener. Compose rather
// than replace it so a browser hello also rebuilds the separate context score.
const mcpNotify = bridge.onNotify
bridge.onNotify = (kind, payload) => {
  mcpNotify?.(kind, payload)
  if (kind === 'hello') {
    void context.browserHello().catch((error: unknown) => {
      console.error(
        '[rondocode-mcp] context browser sync failed:',
        error instanceof Error ? error.message : error,
      )
    })
  }
}

console.error(
  `[rondocode-mcp] ghost-text completion ${completion.available ? 'ENABLED' : 'disabled (no ANTHROPIC_API_KEY)'}`,
)

// Bridge first: an agent's first tool call should meet a listening ws even
// if the browser hasn't dialed in yet (it gets the actionable NO_SESSION
// error, not a dead port).
await bridge.listen()
console.error(`[rondocode-mcp] bridge listening on ws://localhost:${bridge.port}/session`)
console.error(`[rondocode-mcp] context telemetry listening on http://localhost:${bridge.port}/context`)

let stopFocusWatcher: (() => void) | undefined
if (
  process.env['RONDOCODE_FOCUS_WATCHER'] !== '0' &&
  (process.platform === 'darwin' || process.platform === 'linux')
) {
  const { startFocusWatcher } = await import('../adapters/focus-watcher')
  const watcher = startFocusWatcher()
  stopFocusWatcher = () => watcher.stop()
}

await server.connect(new StdioServerTransport())
console.error('[rondocode-mcp] mcp server ready on stdio')

let shuttingDown = false
const shutdown = (): void => {
  if (shuttingDown) return
  shuttingDown = true
  stopFocusWatcher?.()
  void bridge.close().then(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
// Claude Code signals shutdown by closing our stdin.
process.stdin.on('close', shutdown)
