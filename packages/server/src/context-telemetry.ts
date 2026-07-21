/* ------------------------------------------------------------------------- *
 * Context telemetry normalisation + musical pressure mapping.
 *
 * Harness adapters report either a percentage or token counts. This module
 * turns those inconsistent inputs into one stable 0..1 pressure signal, tracks
 * multiple sessions, applies smoothing + hysteresis, and produces the live
 * parameter values for the procedural context score.
 * ------------------------------------------------------------------------- */

export const CONTEXT_ZONE_THRESHOLDS = [0.06, 0.12, 0.25, 0.4, 0.55] as const
export const CONTEXT_ZONE_NAMES = ['open', 'flow', 'build', 'tense', 'urgent', 'critical'] as const

export type ContextZone = 0 | 1 | 2 | 3 | 4 | 5
export type ContextZoneName = (typeof CONTEXT_ZONE_NAMES)[ContextZone]
export type ContextEvent = 'usage' | 'compact-start' | 'compact-end' | 'focus' | 'session-end'

export interface ContextTelemetry {
  version?: 1
  source?: string
  model?: string
  sessionId: string
  event?: ContextEvent
  rawPercent?: number
  usedTokens?: number
  contextWindow?: number
  effectiveLimitTokens?: number
  reserveTokens?: number
  focused?: boolean
  cwd?: string
  timestamp?: string | number
}

export interface ContextState {
  sessionId: string
  source: string
  model?: string
  cwd?: string
  contextWindow?: number
  rawPressure: number
  pressure: number
  zone: ContextZone
  zoneName: ContextZoneName
  focused: boolean
  compacting: boolean
  release: boolean
  updatedAt: number
}

interface MutableContextState extends ContextState {
  /** Whether focus was explicitly supplied for this session. */
  focusKnown: boolean
}

export interface ContextEngineOpts {
  now?: () => number
  /** Share of each new reading applied to the smoothed value. Default 0.22. */
  smoothing?: number
  /** Downward dead-band around zone thresholds. Default 0.04. */
  hysteresis?: number
}

export interface ContextParamUpdate {
  addr: string
  value: number
  rampMs?: number
}

export interface ContextChannelUpdate {
  synth: string
  gain?: number
  pan?: number
}

export interface ContextMix {
  state?: ContextState
  params: ContextParamUpdate[]
  channels: ContextChannelUpdate[]
}

export class ContextInputError extends TypeError {}

const EVENTS: ReadonlySet<string> = new Set<ContextEvent>([
  'usage',
  'compact-start',
  'compact-end',
  'focus',
  'session-end',
])

const SCORE_SYNTHS = [
  'ctx_pad',
  'ctx_piano',
  'ctx_bass',
  'ctx_kick',
  'ctx_snare',
  'ctx_hat',
  'ctx_hat_fast',
  'ctx_arp',
  'ctx_lead',
  'ctx_counter',
  'ctx_last',
  'ctx_release',
] as const

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)

const optionalString = (obj: Record<string, unknown>, key: string): string | undefined => {
  const value = obj[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new ContextInputError(`${key} must be a string`)
  return value
}

const optionalNumber = (obj: Record<string, unknown>, key: string): number | undefined => {
  const value = obj[key]
  if (value === undefined) return undefined
  if (!finite(value)) throw new ContextInputError(`${key} must be a finite number`)
  return value
}

export function parseContextTelemetry(input: unknown): ContextTelemetry {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new ContextInputError('context telemetry must be a JSON object')
  }
  const obj = input as Record<string, unknown>
  const sessionId = obj['sessionId']
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    throw new ContextInputError('sessionId must be a non-empty string')
  }

  let event: ContextEvent | undefined
  if (obj['event'] !== undefined) {
    if (typeof obj['event'] !== 'string' || !EVENTS.has(obj['event'])) {
      throw new ContextInputError(
        `event must be one of ${[...EVENTS].join(', ')}`,
      )
    }
    event = obj['event'] as ContextEvent
  }

  let focused: boolean | undefined
  if (obj['focused'] !== undefined) {
    if (typeof obj['focused'] !== 'boolean') {
      throw new ContextInputError('focused must be a boolean')
    }
    focused = obj['focused']
  }

  let timestamp: string | number | undefined
  if (obj['timestamp'] !== undefined) {
    const value = obj['timestamp']
    if (typeof value !== 'string' && !finite(value)) {
      throw new ContextInputError('timestamp must be an ISO string or epoch number')
    }
    timestamp = value as string | number
  }

  const telemetry: ContextTelemetry = {
    sessionId: sessionId.trim(),
  }
  const version = optionalNumber(obj, 'version')
  if (version !== undefined) {
    if (version !== 1) throw new ContextInputError(`unsupported context telemetry version ${version}`)
    telemetry.version = 1
  }
  const source = optionalString(obj, 'source')
  if (source !== undefined) telemetry.source = source
  const model = optionalString(obj, 'model')
  if (model !== undefined) telemetry.model = model
  const cwd = optionalString(obj, 'cwd')
  if (cwd !== undefined) telemetry.cwd = cwd
  if (event !== undefined) telemetry.event = event
  if (focused !== undefined) telemetry.focused = focused
  if (timestamp !== undefined) telemetry.timestamp = timestamp

  for (const key of [
    'rawPercent',
    'usedTokens',
    'contextWindow',
    'effectiveLimitTokens',
    'reserveTokens',
  ] as const) {
    const value = optionalNumber(obj, key)
    if (value !== undefined) telemetry[key] = value
  }

  if (telemetry.rawPercent !== undefined && (telemetry.rawPercent < 0 || telemetry.rawPercent > 1000)) {
    throw new ContextInputError('rawPercent must be between 0 and 1000')
  }
  for (const key of ['usedTokens', 'contextWindow', 'effectiveLimitTokens', 'reserveTokens'] as const) {
    const value = telemetry[key]
    if (value !== undefined && value < 0) {
      throw new ContextInputError(`${key} must be non-negative`)
    }
  }
  return telemetry
}

/** Prefer token counts because they can account for a harness's reserve. */
export function rawPressureOf(input: ContextTelemetry): number | undefined {
  if (finite(input.usedTokens)) {
    let limit: number | undefined
    if (finite(input.effectiveLimitTokens) && input.effectiveLimitTokens > 0) {
      limit = input.effectiveLimitTokens
    } else if (finite(input.contextWindow) && input.contextWindow > 0) {
      const reserve = finite(input.reserveTokens) ? input.reserveTokens : 0
      const effective = input.contextWindow - reserve
      if (effective > 0) limit = effective
    }
    if (limit !== undefined) return clamp01(input.usedTokens / limit)
  }
  if (finite(input.rawPercent)) return clamp01(input.rawPercent / 100)
  return undefined
}

export function directZone(pressure: number): ContextZone {
  const p = clamp01(pressure)
  let zone = 0
  while (zone < CONTEXT_ZONE_THRESHOLDS.length && p >= CONTEXT_ZONE_THRESHOLDS[zone]!) {
    zone++
  }
  return zone as ContextZone
}

/**
 * Enter a higher zone at its published threshold. Leave it only after falling
 * `margin` below that threshold. This prevents a 69.9/70.1 reading from
 * rearranging the orchestra every second like a deeply indecisive conductor.
 */
export function hystereticZone(
  previous: ContextZone,
  pressure: number,
  margin = 0.04,
): ContextZone {
  const p = clamp01(pressure)
  let zone: number = previous
  while (zone < CONTEXT_ZONE_THRESHOLDS.length && p >= CONTEXT_ZONE_THRESHOLDS[zone]!) {
    zone++
  }
  while (zone > 0 && p < CONTEXT_ZONE_THRESHOLDS[zone - 1]! - margin) {
    zone--
  }
  return zone as ContextZone
}

const timeOf = (value: string | number | undefined, fallback: number): number => {
  if (typeof value === 'number') return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

const publicState = (state: MutableContextState): ContextState => {
  const { focusKnown: _focusKnown, ...out } = state
  return { ...out }
}

export class ContextPressureEngine {
  private readonly now: () => number
  private readonly smoothing: number
  private readonly hysteresis: number
  private readonly byId = new Map<string, MutableContextState>()
  private activeId: string | undefined

  constructor(opts?: ContextEngineOpts) {
    this.now = opts?.now ?? (() => Date.now())
    this.smoothing = clamp01(opts?.smoothing ?? 0.22)
    this.hysteresis = clamp01(opts?.hysteresis ?? 0.04)
  }

  ingest(input: ContextTelemetry): ContextState | undefined {
    const event = input.event ?? 'usage'
    if (event === 'session-end') {
      this.byId.delete(input.sessionId)
      if (this.activeId === input.sessionId) this.activeId = undefined
      return undefined
    }

    const now = timeOf(input.timestamp, this.now())
    const previous = this.byId.get(input.sessionId)
    let raw = rawPressureOf(input)
    if (raw === undefined) raw = previous?.rawPressure ?? 0
    if (event === 'compact-end' && rawPressureOf(input) === undefined) {
      // A lifecycle hook may not include a fresh usage snapshot. Give the ear an
      // immediate, conservative release until the next status update arrives.
      raw = Math.min(raw, 0.24)
    }

    const snapDown =
      event === 'compact-end' ||
      (previous !== undefined && previous.pressure - raw >= 0.18)
    const pressure =
      previous === undefined || snapDown
        ? raw
        : previous.pressure + (raw - previous.pressure) * this.smoothing
    const zone =
      previous === undefined || snapDown
        ? directZone(pressure)
        : hystereticZone(previous.zone, pressure, this.hysteresis)

    const explicitFocus = input.focused !== undefined
    let focused = input.focused ?? previous?.focused ?? false
    if (input.focused === true) {
      this.activeId = input.sessionId
      for (const state of this.byId.values()) state.focused = false
      focused = true
    } else if (input.focused === false && this.activeId === input.sessionId) {
      this.activeId = undefined
    } else if (this.activeId === undefined && previous === undefined) {
      // A single unannotated harness should still work. Later sessions only
      // take over through focus or recency selection in ContextService.
      this.activeId = input.sessionId
      focused = true
    }

    const compacting =
      event === 'compact-start'
        ? true
        : event === 'compact-end'
          ? false
          : previous?.compacting ?? false
    const release = event === 'compact-end'

    const state: MutableContextState = {
      sessionId: input.sessionId,
      source: input.source ?? previous?.source ?? 'unknown',
      rawPressure: raw,
      pressure: clamp01(pressure),
      zone,
      zoneName: CONTEXT_ZONE_NAMES[zone],
      focused,
      compacting,
      release,
      updatedAt: now,
      focusKnown: explicitFocus || previous?.focusKnown === true,
    }
    if (input.model ?? previous?.model) state.model = input.model ?? previous!.model
    if (input.cwd ?? previous?.cwd) state.cwd = input.cwd ?? previous!.cwd
    if (input.contextWindow ?? previous?.contextWindow) {
      state.contextWindow = input.contextWindow ?? previous!.contextWindow
    }
    this.byId.set(input.sessionId, state)
    return publicState(state)
  }

  /** Select one registered session, clearing the session-level focus flag on the rest. */
  focus(sessionId: string | undefined): ContextState | undefined {
    this.activeId = sessionId
    for (const state of this.byId.values()) state.focused = state.sessionId === sessionId
    return sessionId === undefined ? undefined : this.get(sessionId)
  }

  get activeSessionId(): string | undefined {
    return this.activeId
  }

  get active(): ContextState | undefined {
    return this.activeId === undefined ? undefined : this.get(this.activeId)
  }

  get(sessionId: string): ContextState | undefined {
    const state = this.byId.get(sessionId)
    return state === undefined ? undefined : publicState(state)
  }

  states(): ContextState[] {
    return [...this.byId.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(publicState)
  }

  mostRecent(): ContextState | undefined {
    return this.states()[0]
  }

  /** Best-effort title match for terminals/editors that expose cwd or session id. */
  matchTitle(title: string): ContextState | undefined {
    const needle = title.toLowerCase()
    const matches = [...this.byId.values()].filter((state) => {
      if (needle.includes(state.sessionId.toLowerCase())) return true
      const cwd = state.cwd?.replace(/[\\/]+$/, '')
      if (cwd === undefined || cwd === '') return false
      const base = cwd.split(/[\\/]/).at(-1)
      return base !== undefined && base !== '' && needle.includes(base.toLowerCase())
    })
    if (matches.length === 0) return undefined
    // Several sessions can share a cwd basename that appears in the title
    // (e.g. multiple terminals in the same repo). Keep the already-active one
    // rather than letting a background session's newer updatedAt steal the
    // foreground; the foreground is claimed by user input, not telemetry.
    const activeMatch =
      this.activeId === undefined ? undefined : matches.find((s) => s.sessionId === this.activeId)
    const sorted = matches.sort((a, b) => b.updatedAt - a.updatedAt)
    const chosen = activeMatch ?? sorted[0]
    return chosen === undefined ? undefined : publicState(chosen)
  }
}

/** Continuous score controls. Pattern density itself is zone-quantized in danmaku-score.ts. */
export function contextMix(state: ContextState | undefined, audible = true): ContextMix {
  const pressure = state?.pressure ?? 0
  const energy = Math.pow(clamp01(pressure), 1.7)
  const master = audible && state !== undefined ? 1 : 0
  const rampMs = state?.release === true ? 260 : 900
  const gain = (value: number): number => clamp01(value * master)

  const layerGain: Record<(typeof SCORE_SYNTHS)[number], number> = {
    ctx_pad: 0.48,
    ctx_piano: 0.68,
    ctx_bass: 0.38 + energy * 0.2,
    ctx_kick: 0.42 + energy * 0.22,
    ctx_snare: 0.35 + energy * 0.2,
    ctx_hat: 0.24 + energy * 0.18,
    ctx_hat_fast: state !== undefined && state.zone >= 3 ? 0.15 + energy * 0.28 : 0,
    ctx_arp: state !== undefined && state.zone >= 2 ? 0.24 + energy * 0.3 : 0,
    ctx_lead: state !== undefined && state.zone >= 2 ? 0.28 + energy * 0.26 : 0,
    ctx_counter: state !== undefined && state.zone >= 3 ? 0.2 + energy * 0.25 : 0,
    ctx_last: state !== undefined && state.zone >= 5 ? 0.24 + energy * 0.3 : 0,
    ctx_release: state?.release === true ? 0.55 : 0,
  }

  return {
    ...(state !== undefined ? { state } : {}),
    params: [
      { addr: 'ctx_pad.bright', value: 700 + energy * 2500, rampMs },
      { addr: 'ctx_piano.bright', value: 1600 + energy * 4300, rampMs },
      { addr: 'ctx_bass.bright', value: 450 + energy * 1550, rampMs },
      { addr: 'ctx_arp.bright', value: 2100 + energy * 6500, rampMs },
      { addr: 'ctx_lead.bright', value: 2400 + energy * 6900, rampMs },
      { addr: 'ctx_lead.vibrato', value: 4.3 + energy * 2.2, rampMs },
      { addr: 'ctx_counter.bright', value: 1800 + energy * 6200, rampMs },
      { addr: 'ctx_last.bright', value: 3000 + energy * 6500, rampMs },
    ],
    channels: SCORE_SYNTHS.map((synth) => ({ synth, gain: gain(layerGain[synth]) })),
  }
}
