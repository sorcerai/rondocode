import './style.css'
import { AudioSession } from './audio/AudioSession'
import { mountEditor } from './editor/editor'
import type { EditorHandle } from './editor/editor'
import { mountLibrary } from './editor/library'
import { mountDocs } from './editor/docspanel'
import { mountSynthLib } from './editor/synthlib'
import { mountShaderViz } from './shaderviz/shaderviz'
import { BridgeClient } from './session/bridge-client'
import { applyPalette } from './ui/palette'
import { mountViz } from './viz/viz'

/* MCP + context bridge wiring: expose the Session command API to the local
 * bridge server (see session/bridge-client.ts for protocol, reach, and the
 * notification-seam rationale). Purely additive — the editor keeps sole
 * ownership of the Session's own callbacks; state notifications ride the
 * EditorHandle.onState subscription seam. The client is silent and retries
 * with backoff when no bridge is running, so the app works standalone. */
const startBridge = (editor: EditorHandle): void => {
  const session = editor.session
  const str = (v: unknown, name: string): string => {
    if (typeof v !== 'string') throw new TypeError(`${name} must be a string`)
    return v
  }
  const num = (v: unknown, name: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new TypeError(`${name} must be a finite number`)
    }
    return v
  }
  const obj = (p: unknown): Record<string, unknown> =>
    typeof p === 'object' && p !== null ? (p as Record<string, unknown>) : {}
  const arr = (v: unknown, name: string): unknown[] => {
    if (!Array.isArray(v)) throw new TypeError(`${name} must be an array`)
    return v
  }

  const client = new BridgeClient({
    handlers: {
      evalCode: (p) => session.evalCode(str(obj(p).source, 'source')),
      getCode: () => ({ code: session.code, lastAttempted: session.lastAttempted }),
      setParam: (p) => {
        const q = obj(p)
        session.setParam(
          str(q.addr, 'addr'),
          num(q.value, 'value'),
          q.rampMs === undefined ? undefined : num(q.rampMs, 'rampMs'),
        )
      },
      setChannel: (p) => {
        const q = obj(p)
        session.setChannel(str(q.synth, 'synth'), {
          gain: q.gain === undefined ? undefined : num(q.gain, 'gain'),
          pan: q.pan === undefined ? undefined : num(q.pan, 'pan'),
        })
      },
      transport: (p) => {
        const q = obj(p)
        const cmd = str(q.cmd, 'cmd')
        if (cmd !== 'play' && cmd !== 'stop') throw new TypeError(`cmd must be play|stop`)
        session.transport(cmd, q.cps === undefined ? undefined : { cps: num(q.cps, 'cps') })
      },

      // Context mode loads a trusted, fixed program from the local bridge
      // without replacing the user's editor buffer. The browser may still need
      // one click to unlock audio, because autoplay policy enjoys bureaucracy.
      startContextScore: (p) => {
        const q = obj(p)
        const result = session.evalCode(str(q.source, 'source'))
        if (result.ok && !session.getState().playing) {
          session.transport(
            'play',
            q.cps === undefined ? undefined : { cps: num(q.cps, 'cps') },
          )
        }
        return {
          ok: result.ok,
          diagnostics: result.diagnostics,
          state: session.getState(),
        }
      },

      // One round trip for a whole pressure frame. Param ramps do the musical
      // crossfade inside the AudioWorklet; zone-only code re-evals happen separately.
      applyContext: (p) => {
        const q = obj(p)
        for (const raw of arr(q.params, 'params')) {
          const update = obj(raw)
          session.setParam(
            str(update.addr, 'params[].addr'),
            num(update.value, 'params[].value'),
            update.rampMs === undefined
              ? undefined
              : num(update.rampMs, 'params[].rampMs'),
          )
        }
        for (const raw of arr(q.channels ?? [], 'channels')) {
          const update = obj(raw)
          session.setChannel(str(update.synth, 'channels[].synth'), {
            gain:
              update.gain === undefined
                ? undefined
                : num(update.gain, 'channels[].gain'),
            pan:
              update.pan === undefined
                ? undefined
                : num(update.pan, 'channels[].pan'),
          })
        }
        return session.getState()
      },
      getState: () => session.getState(),
    },
    getState: () => session.getState(),
    subscribeState: (fn) => editor.onState(fn),
  })
  client.start()
}

// Palette first: style.css consumes var(--c-*) with no fallbacks, so the
// custom properties must exist before anything renders (see ui/palette.ts).
applyPalette()

const app = document.getElementById('app')
if (!app) throw new Error('missing #app root')

/* No tap-to-start gate: the audio graph is built at load in a SUSPENDED
 * context (silent, no gesture needed), so the editor mounts immediately. The
 * first Run resumes the context from its own click/keypress gesture — that's
 * where the browser's audio-unlock requirement is satisfied (see editor.ts). */
AudioSession.start().then(
  (audio) => {
    // Context mode can be started by the local bridge, outside a browser
    // gesture. Unlock on the first ordinary click/key anywhere in the app so
    // users are not required to press Run on a hidden background score.
    const unlockAudio = (): void => {
      document.removeEventListener('pointerdown', unlockAudio, true)
      document.removeEventListener('keydown', unlockAudio, true)
      void audio.resume().catch(() => {
        // The normal Run button remains the fallback gesture.
      })
    }
    document.addEventListener('pointerdown', unlockAudio, { capture: true })
    document.addEventListener('keydown', unlockAudio, { capture: true })

    const editor = mountEditor(app, audio)
    mountViz(app, editor, audio)
    void mountLibrary(editor).catch((e) => console.warn('[library] failed to mount', e))
    mountDocs(editor)
    mountSynthLib(editor)
    mountShaderViz(app, editor, audio)
    startBridge(editor)
  },
  (e: unknown) => {
    const banner = document.createElement('div')
    banner.className = 'boot-error'
    banner.textContent = `audio failed to start: ${e instanceof Error ? e.message : String(e)}`
    app.append(banner)
  },
)
