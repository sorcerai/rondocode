import {
  ContextPressureEngine,
  contextMix,
  type ContextState,
  type ContextTelemetry,
} from './context-telemetry'
import {
  CONTEXT_SCORE_CPS,
  danmakuContextScore,
  type ContextScoreMode,
} from './danmaku-score'

export interface ContextBrowserBridge {
  readonly connected: boolean
  call(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>
}

export interface ContextServiceOpts {
  getBridge: () => ContextBrowserBridge
  engine?: ContextPressureEngine
  now?: () => number
  releaseMs?: number
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown
  clearTimeoutImpl?: (handle: unknown) => void
}

export class ContextUnavailableError extends Error {}

export class ContextService {
  private readonly getBridge: () => ContextBrowserBridge
  private readonly engine: ContextPressureEngine
  private readonly now: () => number
  private readonly releaseMs: number
  private readonly setTimeoutImpl: (fn: () => void, ms: number) => unknown
  private readonly clearTimeoutImpl: (handle: unknown) => void

  private foregroundAllowed = true
  private foregroundApp: string | undefined
  private foregroundTitle: string | undefined
  private releaseUntil = 0
  private releaseTimer: unknown
  private scoreKey: string | undefined
  private browserStarted = false
  private serial: Promise<void> = Promise.resolve()
  private lastError: string | undefined

  constructor(opts: ContextServiceOpts) {
    this.getBridge = opts.getBridge
    this.engine = opts.engine ?? new ContextPressureEngine()
    this.now = opts.now ?? (() => Date.now())
    this.releaseMs = Math.max(200, opts.releaseMs ?? 2400)
    this.setTimeoutImpl = opts.setTimeoutImpl ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimeoutImpl =
      opts.clearTimeoutImpl ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  async ingest(input: ContextTelemetry): Promise<ContextState | undefined> {
    const event = input.event ?? 'usage'
    const state = this.engine.ingest(input)

    // The engine's zero-config fallback selects the first unseen session. An
    // explicit blur must override that fallback even when this is the first
    // event we have ever seen for the session.
    if (input.focused === false && this.engine.activeSessionId === input.sessionId) {
      this.engine.focus(undefined)
    }

    if (event === 'compact-start') {
      this.clearRelease()
    } else if (event === 'compact-end') {
      this.armRelease()
    } else if (event === 'session-end' && this.engine.active === undefined) {
      const fallback = this.engine.mostRecent()
      if (fallback !== undefined) this.engine.focus(fallback.sessionId)
    }

    await this.enqueueSync()
    return state
  }

  async setForeground(input: {
    focused: boolean
    title?: string
    app?: string
  }): Promise<void> {
    this.foregroundAllowed = input.focused
    this.foregroundTitle = input.title
    this.foregroundApp = input.app

    if (input.focused) {
      const matched = input.title === undefined ? undefined : this.engine.matchTitle(input.title)
      const selected = matched ?? this.engine.active ?? this.engine.mostRecent()
      if (selected !== undefined) this.engine.focus(selected.sessionId)
    }
    await this.enqueueSync()
  }

  /** A fresh/reloaded browser lost its score even though telemetry state survived. */
  async browserHello(): Promise<void> {
    this.browserStarted = false
    this.scoreKey = undefined
    await this.enqueueSync()
  }

  status(): {
    browserConnected: boolean
    browserStarted: boolean
    foreground: { allowed: boolean; app?: string; title?: string }
    active?: ContextState
    sessions: ContextState[]
    scoreKey?: string
    releaseUntil?: number
    lastError?: string
  } {
    const now = this.now()
    const releaseActive = this.releaseUntil > now
    const normalizeRelease = (state: ContextState): ContextState =>
      !releaseActive && state.release ? { ...state, release: false } : state
    const activeRaw = this.engine.active
    const active = activeRaw === undefined ? undefined : normalizeRelease(activeRaw)
    const foreground: { allowed: boolean; app?: string; title?: string } = {
      allowed: this.foregroundAllowed,
    }
    if (this.foregroundApp !== undefined) foreground.app = this.foregroundApp
    if (this.foregroundTitle !== undefined) foreground.title = this.foregroundTitle

    return {
      browserConnected: this.getBridge().connected,
      browserStarted: this.browserStarted,
      foreground,
      ...(active !== undefined ? { active } : {}),
      sessions: this.engine.states().map(normalizeRelease),
      ...(this.scoreKey !== undefined ? { scoreKey: this.scoreKey } : {}),
      ...(releaseActive ? { releaseUntil: this.releaseUntil } : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    }
  }

  private armRelease(): void {
    this.clearRelease()
    this.releaseUntil = this.now() + this.releaseMs
    this.releaseTimer = this.setTimeoutImpl(() => {
      this.releaseTimer = undefined
      this.releaseUntil = 0
      void this.enqueueSync().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        this.lastError = message
        console.warn(`[context] release sync failed: ${message}`)
      })
    }, this.releaseMs)
  }

  private clearRelease(): void {
    if (this.releaseTimer !== undefined) this.clearTimeoutImpl(this.releaseTimer)
    this.releaseTimer = undefined
    this.releaseUntil = 0
  }

  private enqueueSync(): Promise<void> {
    const run = async (): Promise<void> => this.syncNow()
    this.serial = this.serial.then(run, run)
    return this.serial
  }

  private modeFor(state: ContextState): ContextScoreMode {
    if (state.compacting) return 'compacting'
    if (this.releaseUntil > this.now()) return 'release'
    return 'normal'
  }

  private async syncNow(): Promise<void> {
    const bridge = this.getBridge()
    if (!bridge.connected) return

    // Do not fall back to the most-recent session here. An explicit
    // `focused:false` must make the score silent, rather than immediately
    // resurrecting the same session through recency.
    const state = this.engine.active
    if (state === undefined) {
      if (this.browserStarted) {
        await this.callBridge('applyContext', contextMix(undefined, false))
      }
      return
    }

    const mode = this.modeFor(state)
    const key = mode === 'normal' ? `${mode}:${state.zone}` : mode
    if (!this.browserStarted || key !== this.scoreKey) {
      const result = await this.callBridge('startContextScore', {
        source: danmakuContextScore(state.zone, mode),
        cps: CONTEXT_SCORE_CPS,
      })
      if (
        typeof result === 'object' &&
        result !== null &&
        'ok' in result &&
        (result as { ok?: unknown }).ok !== true
      ) {
        const diagnostics =
          'diagnostics' in result
            ? (result as { diagnostics?: unknown }).diagnostics
            : undefined
        throw new Error(`context score failed to evaluate: ${JSON.stringify(diagnostics)}`)
      }
      this.browserStarted = true
      this.scoreKey = key
    }

    // `release` is an edge flag on telemetry state, while releaseUntil owns the
    // audible duration. Once the timer expires, neutralize a stale flag even if
    // the harness has not emitted its next usage update yet.
    const mixState = mode === 'normal' && state.release ? { ...state, release: false } : state
    await this.callBridge('applyContext', contextMix(mixState, this.foregroundAllowed))
    this.lastError = undefined
  }

  private async callBridge(method: string, params: unknown): Promise<unknown> {
    try {
      return await this.getBridge().call(method, params, 7000)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastError = message
      if (message.includes('no session connected') || message.includes('session disconnected')) {
        this.browserStarted = false
        this.scoreKey = undefined
        throw new ContextUnavailableError(
          'rondocode browser session is not connected; open or refresh the app',
        )
      }
      throw error
    }
  }
}
