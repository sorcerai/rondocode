#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const execFileAsync = promisify(execFile)

export interface ForegroundWindow {
  app: string
  title: string
}

const DEFAULT_APPS = [
  'terminal',
  'iterm2',
  'warp',
  'ghostty',
  'visual studio code',
  'code',
  'cursor',
  'zed',
  'windsurf',
  'kitty',
  'wezterm',
  'alacritty',
]

const allowedApps = (
  process.env['RONDOCODE_FOCUS_APPS']?.split(',') ?? DEFAULT_APPS
)
  .map((name) => name.trim().toLowerCase())
  .filter((name) => name !== '')

const contextUrl =
  process.env['RONDOCODE_CONTEXT_URL'] ?? 'http://127.0.0.1:6070/context'
const focusUrl =
  process.env['RONDOCODE_FOCUS_URL'] ??
  `${contextUrl.replace(/\/context\/?$/, '')}/context/focus`
const intervalMs = Math.max(200, Number(process.env['RONDOCODE_FOCUS_INTERVAL_MS'] ?? 700))

const macForeground = async (): Promise<ForegroundWindow> => {
  const script = `
    tell application "System Events"
      set frontProcess to first application process whose frontmost is true
      set appName to name of frontProcess
      set windowName to ""
      try
        set windowName to name of front window of frontProcess
      end try
      return appName & "|||RONDOCODE|||" & windowName
    end tell
  `
  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout: 1200,
    maxBuffer: 16_384,
  })
  const [app = '', title = ''] = stdout.trim().split('|||RONDOCODE|||')
  return { app: app.trim(), title: title.trim() }
}

const linuxForeground = async (): Promise<ForegroundWindow> => {
  const active = await execFileAsync('xdotool', ['getactivewindow'], {
    timeout: 800,
    maxBuffer: 4096,
  })
  const id = active.stdout.trim()
  if (id === '') throw new Error('xdotool returned no active window')
  const [klass, title] = await Promise.all([
    execFileAsync('xdotool', ['getwindowclassname', id], {
      timeout: 800,
      maxBuffer: 4096,
    }),
    execFileAsync('xdotool', ['getwindowname', id], {
      timeout: 800,
      maxBuffer: 16_384,
    }),
  ])
  return { app: klass.stdout.trim(), title: title.stdout.trim() }
}

export const readForegroundWindow = async (): Promise<ForegroundWindow> => {
  if (process.platform === 'darwin') return macForeground()
  if (process.platform === 'linux') return linuxForeground()
  throw new Error(`foreground watcher is unsupported on ${process.platform}`)
}

export const isCodingApp = (app: string): boolean => {
  const value = app.toLowerCase()
  return allowedApps.some((allowed) => value === allowed || value.includes(allowed))
}

const postFocus = async (window: ForegroundWindow): Promise<void> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 650)
  try {
    await fetch(focusUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        focused: isCodingApp(window.app),
        app: window.app,
        title: window.title,
      }),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
}

export interface FocusWatcher {
  stop(): void
}

export function startFocusWatcher(): FocusWatcher {
  let stopped = false
  let running = false
  let lastKey = ''
  let lastError = ''

  const poll = async (): Promise<void> => {
    if (stopped || running) return
    running = true
    try {
      const window = await readForegroundWindow()
      const key = `${isCodingApp(window.app)}\0${window.app}\0${window.title}`
      if (key !== lastKey) {
        await postFocus(window)
        lastKey = key
      }
      lastError = ''
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message !== lastError) {
        console.warn(`[context-focus] ${message}`)
        lastError = message
      }
      // Unknown focus does not overwrite the last known gate. Permissions and
      // missing xdotool therefore do not randomly mute/unmute a live session.
    } finally {
      running = false
    }
  }

  void poll()
  const timer = setInterval(() => void poll(), intervalMs)
  console.log(
    `[context-focus] watching foreground apps every ${intervalMs}ms (${allowedApps.join(', ')})`,
  )

  return {
    stop(): void {
      stopped = true
      clearInterval(timer)
    },
  }
}

const entry = process.argv[1]
const direct =
  entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href

if (direct) {
  const watcher = startFocusWatcher()
  process.on('SIGINT', () => {
    watcher.stop()
    process.exit(0)
  })
}
