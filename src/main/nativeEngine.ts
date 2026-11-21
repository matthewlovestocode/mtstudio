/**
 * Runs the native audio engine (`native/`) as a sidecar process and relays
 * its protocol between the renderer and the process's stdin and stdout.
 */
import { app, ipcMain, systemPreferences, type BrowserWindow } from 'electron'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { contentFolder } from './sfz'
import { soundFontPath } from './soundfont'
import type { NativeAsset, NativeCommand, NativeEvent, NativeLatency, NativePlugins, NativeTake } from '@shared/nativeEngine'

type AssetEvent = Extract<NativeEvent, { type: 'asset' }>
type RenderedEvent = Extract<NativeEvent, { type: 'rendered' }>
/** Events that answer a numbered request from this process, rather than going to the renderer. */
type InputEvent = Extract<NativeEvent, { type: 'input' }>
type TakeEvent = Extract<NativeEvent, { type: 'take' }>
type CalibratedEvent = Extract<NativeEvent, { type: 'calibrated' }>
type StreamEvent = Extract<NativeEvent, { type: 'stream' }>
type PluginsEvent = Extract<NativeEvent, { type: 'plugins' }>
type Answer = AssetEvent | RenderedEvent | InputEvent | TakeEvent | CalibratedEvent | StreamEvent | PluginsEvent

/** Where the engine binary is expected: `STUDIO_ENGINE_PATH`, or the build output of `npm run build:native`. */
export function nativeEnginePath(): string {
  if (process.env.STUDIO_ENGINE_PATH) return process.env.STUDIO_ENGINE_PATH
  const name = process.platform === 'win32' ? 'studio-engine.exe' : 'studio-engine'
  return app.isPackaged ? join(process.resourcesPath, name) : join(app.getAppPath(), 'native', 'bin', name)
}

export function nativeEngineBuilt(): boolean {
  return existsSync(nativeEnginePath())
}

/**
 * Starts the engine. It runs for the life of the app; `getWindow` says where
 * its events go, and `streamFile` finds the WAV to read for an asset that
 * can be played from disk (null if it cannot).
 */
export function startNativeEngine(
  getWindow: () => BrowserWindow | null,
  streamFile: (projectPath: string | null, assetPath: string) => Promise<string | null>
): void {
  let child: ChildProcessWithoutNullStreams | null = null
  /** Why the engine is not running, once it has stopped. */
  let gone: string | null = null

  /** Requests the engine has not answered yet, by request number. */
  const loading = new Map<number, { resolve: (event: Answer) => void; reject: (error: Error) => void }>()
  let lastRequest = 0
  /** Sends a numbered request and resolves to the engine's answer. */
  const ask = <T extends Answer>(request: number, command: NativeCommand): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      loading.set(request, { resolve: resolve as (event: Answer) => void, reject })
      child?.stdin.write(`${JSON.stringify(command)}\n`)
    })

  const deliver = (event: NativeEvent): void => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send('engine:event', event)
  }
  const ended = (reason: string): void => {
    if (gone) return
    gone = reason
    child = null
    console.error(`[studio-engine] ${reason}`)
    for (const request of loading.values()) request.reject(new Error(reason))
    loading.clear()
    deliver({ type: 'exit', reason })
  }

  // The engine is told where the sound content is, so that it plays from the same files the app lists.
  child = spawn(nativeEnginePath(), [], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, STUDIO_SOUNDFONT: soundFontPath(), STUDIO_CONTENT: contentFolder() } })
  child.on('error', (error) => ended(`The native audio engine could not be started: ${error.message}`))
  child.on('exit', (code, signal) => ended(`The native audio engine stopped unexpectedly (${signal ?? `exit code ${code}`}).`))
  // A write to an engine that has just died must not take the app down with it.
  child.stdin.on('error', () => {})
  child.stderr.on('data', (data: Buffer) => process.stderr.write(`[studio-engine] ${data.toString()}`))
  createInterface({ input: child.stdout }).on('line', (line) => {
    try {
      const event = JSON.parse(line) as NativeEvent
      if (event.type === 'asset' || event.type === 'rendered' || event.type === 'input' || event.type === 'take' || event.type === 'calibrated' || event.type === 'stream' || event.type === 'plugins') {
        loading.get(event.request)?.resolve(event)
        loading.delete(event.request)
      } else {
        if (event.type === 'ready') output = event.device ?? null
        deliver(event)
      }
    } catch {
      console.error(`[studio-engine] unreadable event: ${line.slice(0, 200)}`)
    }
  })

  ipcMain.on('engine:command', (_event, command: NativeCommand) => {
    if (child) child.stdin.write(`${JSON.stringify(command)}\n`)
    // A renderer that attaches after the engine has died still needs to be told.
    else if (gone && command.type === 'hello') deliver({ type: 'exit', reason: gone })
  })

  // Audio goes to the engine as a file rather than through its stdin, which carries text.
  const assetDir = join(app.getPath('temp'), `studio-engine-${process.pid}`)
  ipcMain.handle('engine:loadAsset', async (_event, assetId: string, data: ArrayBuffer): Promise<NativeAsset> => {
    if (!child) throw new Error(gone ?? 'The native audio engine is not running.')
    const request = ++lastRequest
    const path = join(assetDir, `${request}.audio`)
    await mkdir(assetDir, { recursive: true })
    await writeFile(path, Buffer.from(data))
    try {
      const answer = await ask<AssetEvent>(request, { type: 'loadAsset', request, assetId, path })
      if (answer.error || !answer.peaksPath) throw new Error(answer.error ?? 'The file could not be decoded.')
      const peaks = await readFile(answer.peaksPath)
      return {
        duration: answer.duration ?? 0,
        secondsPerPeak: answer.secondsPerPeak ?? 0,
        peaks: peaks.buffer.slice(peaks.byteOffset, peaks.byteOffset + peaks.byteLength) as ArrayBuffer
      }
    } finally {
      // The engine holds the decoded audio in memory; the files were only the hand-over.
      await Promise.all([rm(path, { force: true }), rm(`${path}.peaks`, { force: true })])
    }
  })

  ipcMain.handle('engine:openStream', async (_event, assetId: string, projectPath: string | null, assetPath: string): Promise<boolean> => {
    if (!child) throw new Error(gone ?? 'The native audio engine is not running.')
    const path = await streamFile(projectPath, assetPath)
    if (!path) return false
    const request = ++lastRequest
    const answer = await ask<StreamEvent>(request, { type: 'openStream', request, assetId, path })
    // Whatever the reason, the caller's fallback is to load the audio into memory, which reports its own errors.
    return !answer.error
  })

  ipcMain.handle('engine:render', async (): Promise<ArrayBuffer> => {
    if (!child) throw new Error(gone ?? 'The native audio engine is not running.')
    const request = ++lastRequest
    const path = join(assetDir, `${request}.wav`)
    await mkdir(assetDir, { recursive: true })
    try {
      const answer = await ask<RenderedEvent>(request, { type: 'render', request, path })
      if (answer.error) throw new Error(answer.error)
      const wav = await readFile(path)
      return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer
    } finally {
      await rm(path, { force: true })
    }
  })

  // ── Audio input and its latency ──────────────────────────────────────────

  /** The audio output in use, and the input last opened (remembered after it is closed). */
  let output: string | null = null
  let input: string | null = null
  /** The round trip the device reported when the input was last opened. */
  let reported: number | null = null
  /** What the renderer last asked for: the track the input is open for, if any. */
  let wanted: { trackId: string; monitor: boolean } | null = null

  // Measured latencies by "output|input" device names, kept between sessions.
  const latencyPath = join(app.getPath('userData'), 'native-engine.json')
  let measured: Record<string, number> = {}
  try {
    measured = (JSON.parse(readFileSync(latencyPath, 'utf8')) as { latency?: Record<string, number> }).latency ?? {}
  } catch {
    // No measurements yet.
  }
  const saveMeasured = (): Promise<void> => writeFile(latencyPath, JSON.stringify({ latency: measured }, null, 2), 'utf8')
  /** The key for the devices in use. Before an input has been opened this session, any input measured with this output. */
  const latencyKey = (): string | null =>
    input !== null ? `${output}|${input}` : (Object.keys(measured).find((key) => key.startsWith(`${output}|`)) ?? null)
  const latency = (): NativeLatency => {
    const key = latencyKey()
    return { measured: key !== null ? (measured[key] ?? null) : null, reported, output, input: input ?? key?.slice(`${output}|`.length) ?? null }
  }

  /** Opens the input for a track, or closes it. Throws if the engine cannot. */
  const openInput = async (trackId: string | null, monitor: boolean): Promise<void> => {
    if (!child) throw new Error(gone ?? 'The native audio engine is not running.')
    // The engine is this app's child, so it records under this app's microphone permission. Without it
    // macOS hands over silence rather than an error, so ask (the first time) and refuse plainly if denied.
    if (trackId && process.platform === 'darwin' && !(await systemPreferences.askForMediaAccess('microphone'))) {
      throw new Error('Studio is not allowed to use the microphone. Allow it in System Settings › Privacy & Security › Microphone.')
    }
    const request = ++lastRequest
    const answer = await ask<InputEvent>(request, { type: 'setInput', request, trackId, monitor })
    if (answer.error) throw new Error(answer.error)
    if (trackId) {
      input = answer.device || null
      reported = answer.latency ?? null
    }
  }

  ipcMain.handle('engine:setInput', async (_event, trackId: string | null, monitor: boolean): Promise<void> => {
    wanted = null
    await openInput(trackId, monitor)
    wanted = trackId ? { trackId, monitor } : null
  })

  ipcMain.handle('engine:latency', (): NativeLatency => latency())

  ipcMain.handle('engine:clearLatency', async (): Promise<NativeLatency> => {
    const key = latencyKey()
    if (key !== null && key in measured) {
      delete measured[key]
      await saveMeasured()
    }
    return latency()
  })

  ipcMain.handle('engine:calibrateLatency', async (): Promise<NativeLatency> => {
    // The input has to be open, and not monitored: hearing itself would blur the measurement.
    const before = wanted
    await openInput(before?.trackId ?? '(calibration)', false)
    try {
      const request = ++lastRequest
      const answer = await ask<CalibratedEvent>(request, { type: 'calibrate', request })
      if (answer.error || answer.seconds === undefined) throw new Error(answer.error ?? 'The measurement failed.')
      reported = answer.reported ?? reported
      measured[`${output}|${input}`] = answer.seconds
      await saveMeasured()
      return latency()
    } finally {
      // Put the input back as it was: open for the armed track, or closed.
      await openInput(before?.trackId ?? null, before?.monitor ?? false).catch(() => {})
    }
  })

  ipcMain.handle('engine:stopRecording', async (): Promise<NativeTake | null> => {
    if (!child) throw new Error(gone ?? 'The native audio engine is not running.')
    const request = ++lastRequest
    const path = join(assetDir, `${request}-take.wav`)
    await mkdir(assetDir, { recursive: true })
    try {
      const answer = await ask<TakeEvent>(request, { type: 'stopRecording', request, path })
      if (answer.error) throw new Error(answer.error)
      if (!answer.frames) return null
      if (answer.dropped) console.warn(`[studio-engine] ${answer.dropped} frames of the take were lost.`)
      const wav = await readFile(path)
      return {
        wav: wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength) as ArrayBuffer,
        startTick: answer.startTick ?? 0,
        // A measured round trip beats the device's own figure. Either way the music was heard later still
        // by the delay that keeps plugins in step.
        offset: (latency().measured ?? answer.offset ?? 0) + (answer.compensation ?? 0)
      }
    } finally {
      await rm(path, { force: true })
    }
  })

  // ── Plugins ──────────────────────────────────────────────────────────────

  // The list of installed plugins is kept between sessions: finding them means loading every one.
  const pluginsPath = join(app.getPath('userData'), 'plugins.json')
  let scanning: Promise<NativePlugins> | null = null
  ipcMain.handle('engine:plugins', async (_event, rescan: boolean): Promise<NativePlugins | null> => {
    if (!rescan) {
      try {
        return JSON.parse(await readFile(pluginsPath, 'utf8')) as NativePlugins
      } catch {
        // Never scanned. Scanning loads every plugin, so it waits to be asked for.
        return null
      }
    }
    if (!child) throw new Error(gone ?? 'The native audio engine is not running.')
    // One scan at a time; a second asker waits for the first.
    scanning ??= (async () => {
      const request = ++lastRequest
      const answer = await ask<PluginsEvent>(request, { type: 'scanPlugins', request })
      const found: NativePlugins = { plugins: answer.plugins, failed: answer.failed }
      await writeFile(pluginsPath, JSON.stringify(found), 'utf8')
      return found
    })().finally(() => {
      scanning = null
    })
    return scanning
  })

  // Plugin windows belong to the engine process. They float above the app while it is in front, and stop when it is not.
  const focus = (focused: boolean): void => {
    child?.stdin.write(`${JSON.stringify({ type: 'appFocus', focused } satisfies NativeCommand)}\n`)
  }
  app.on('browser-window-focus', () => focus(true))
  app.on('browser-window-blur', () => focus(false))

  // Closing its stdin is how the engine is told to quit.
  app.on('will-quit', () => {
    gone ??= 'The app is quitting.'
    child?.stdin.end()
    child = null
    // Synchronous: the process is about to go, and would not wait for a promise.
    rmSync(assetDir, { recursive: true, force: true })
  })
}
