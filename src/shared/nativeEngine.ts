/**
 * The protocol between the app and the native audio engine (`native/`), a
 * sidecar process started by the main process. Each message is one JSON
 * object on its own line: commands go to the engine's stdin, events come back
 * on its stdout. The renderer reaches it through `StudioBridge.nativeEngine`.
 */
import type { Id, PluginRef, Project } from './model'

export type EngineKind = 'web' | 'native'

/**
 * Transport commands carry a sequence number, which the engine echoes in its
 * state events once it has acted on them, so the app can tell a report that
 * predates a command from one that follows it.
 */
export type NativeCommand =
  /** A renderer has attached: stop the transport and send `ready` again. */
  | { type: 'hello'; seq: number }
  /**
   * The engine loads the plugins the project names, but their settings
   * (`Effect.state`, `Track.pluginState`) are left out here and sent with
   * `pluginState` only when they change: they can be large.
   */
  | { type: 'setProject'; project: Project }
  /**
   * Give a plugin the settings the project holds; null means the ones it
   * started with. `effectId` is null for a track's instrument, here and below.
   */
  | { type: 'pluginState'; trackId: Id; effectId: Id | null; state: string | null }
  /** Open the plugin's own window, or bring it to the front. */
  | { type: 'showPlugin'; trackId: Id; effectId: Id | null }
  /** Set one of a plugin's parameters, by its position in the plugin's list, to 0–1. The app does not send this yet; tests do. */
  | { type: 'pluginParam'; trackId: Id; effectId: Id | null; index: number; value: number }
  /** The app's window came to the front or left it; plugin windows float above it only while it is in front. Sent by the main process. */
  | { type: 'appFocus'; focused: boolean }
  /** Look for installed plugins. Answered, perhaps minutes later, by a `plugins` event. Sent by the main process. */
  | { type: 'scanPlugins'; request: number }
  /** With `capture`, the open audio input is recorded from the frame the transport starts on. */
  | { type: 'play'; seq: number; ignoreLoop: boolean; capture: boolean }
  | { type: 'stop'; seq: number }
  | { type: 'seek'; seq: number; tick: number }
  | { type: 'setMetronome'; enabled: boolean }
  | { type: 'noteOn'; trackId: Id; pitch: number; velocity: number }
  | { type: 'noteOff'; trackId: Id; pitch: number }
  /**
   * Decode the audio file at `path` and keep it as `assetId`. Answered by an
   * `asset` event with the same `request` number. Sent by the main process,
   * which puts the bytes from `NativeEngineBridge.loadAsset` in a file first.
   */
  | { type: 'loadAsset'; request: number; assetId: Id; path: string }
  /**
   * Make the audio file at `path` playable as `assetId` straight from disk,
   * without loading it. Answered by a `stream` event. Sent by the main
   * process, which works out which file to read.
   */
  | { type: 'openStream'; request: number; assetId: Id; path: string }
  /**
   * Render the whole project to a stereo 24-bit WAV file at `path`. Answered
   * by a `rendered` event with the same `request` number. Sent by the main
   * process on behalf of `NativeEngineBridge.render`.
   */
  | { type: 'render'; request: number; path: string }
  /**
   * Open the default audio input for a track (heard through it with
   * `monitor`), or close it when `trackId` is null. Answered by an `input`
   * event. Sent by the main process, which checks microphone access first.
   */
  | { type: 'setInput'; request: number; trackId: Id | null; monitor: boolean }
  /**
   * Measure the round trip from output to input: play a short pattern of
   * noise bursts and listen for it on the open input. Answered by a
   * `calibrated` event. Sent by the main process, which opens the input first.
   */
  | { type: 'calibrate'; request: number }
  /** End the take and write it to `path` as a float WAV. Answered by a `take` event. Sent by the main process. */
  | { type: 'stopRecording'; request: number; path: string }

export type NativeEvent =
  | {
      type: 'ready'
      /** Absent, with `error` set, when no audio output could be opened. */
      device?: string
      sampleRate?: number
      bufferSize?: number
      /** Seconds. */
      outputLatency?: number
      error?: string
    }
  /** Sent about sixty times a second. */
  | {
      type: 'state'
      /** The last transport command acted on. */
      seq: number
      playing: boolean
      tick: number
      /** Highest level since the previous event, by track id, plus 'master'. */
      peaks: Record<string, number>
    }
  /** The answer to `loadAsset`: either `error`, or the rest. Handled by the main process. */
  | {
      type: 'asset'
      request: number
      /** Seconds. */
      duration?: number
      secondsPerPeak?: number
      /** A file of raw 32-bit floats: the waveform overview described by `AssetInfo.peaks`. */
      peaksPath?: string
      error?: string
    }
  /**
   * The answer to `openStream`. `error` is 'rate' when the file is not at the
   * device's sample rate, which the engine only handles for files in memory.
   * Handled by the main process.
   */
  | { type: 'stream'; request: number; duration?: number; error?: string }
  /** The answer to `render`; the file is complete unless `error` is set. Handled by the main process. */
  | { type: 'rendered'; request: number; error?: string }
  /** The answer to `setInput`. Handled by the main process. */
  | { type: 'input'; request: number; error?: string; device?: string; channels?: number; latency?: number }
  /** The answer to `calibrate`: `seconds` unless `error` is set. `clarity` says how far the match stood out. Handled by the main process. */
  | { type: 'calibrated'; request: number; seconds?: number; reported?: number; clarity?: number; error?: string }
  /** The answer to `stopRecording`; `frames` is 0 when nothing was captured. Handled by the main process. */
  | {
      type: 'take'
      request: number
      frames: number
      /** Timeline position of the take's first frame. */
      startTick?: number
      /** Seconds to skip at the start of the file: the round-trip latency the device reports. */
      offset?: number
      /** Seconds the whole mix is held back to keep plugins with latency in step, which the take is late by as well. */
      compensation?: number
      /** Frames lost to an overloaded machine. */
      dropped?: number
      error?: string
    }
  /** The answer to `scanPlugins`. `failed` names plugins that crashed or hung while being examined. Handled by the main process. */
  | { type: 'plugins'; request: number; plugins: PluginRef[]; failed: string[] }
  /** A plugin's settings changed (in its window, say); the project should record them. */
  | { type: 'pluginState'; trackId: Id; effectId: Id | null; state: string }
  /** A plugin the project names was loaded, or (with `error`) could not be. */
  | { type: 'pluginStatus'; trackId: Id; effectId: Id | null; error?: string }
  | { type: 'error'; message: string }
  /** The engine process has gone (sent by the main process, not the engine). */
  | { type: 'exit'; reason: string }

/** A decoded file's length and waveform overview; `peaks` holds 32-bit floats. */
export interface NativeAsset {
  duration: number
  secondsPerPeak: number
  peaks: ArrayBuffer
}

/** A recorded take, as `RecordedTake` in the renderer's engine types. */
export interface NativeTake {
  wav: ArrayBuffer
  startTick: number
  offset: number
}

/**
 * How much later than the music a recorded sound lands in a take, in
 * seconds, for the audio devices in use. Takes are shifted by `measured` if
 * there is one, otherwise by what the device reports.
 */
export interface NativeLatency {
  /** From a calibration with these devices, kept between sessions; null if never measured. */
  measured: number | null
  /** What the device claims; null until an input has been opened. */
  reported: number | null
  output: string | null
  input: string | null
}

/** The installed plugins, from the last scan. */
export interface NativePlugins {
  plugins: PluginRef[]
  /** Plugins that crashed or hung while being examined, and so are not offered. */
  failed: string[]
}

export interface NativeEngineBridge {
  send(command: NativeCommand): void
  /** Hands an audio file to the engine to decode and keep in memory. Rejects if it cannot be decoded. */
  loadAsset(assetId: Id, data: ArrayBuffer): Promise<NativeAsset>
  /**
   * Has the engine play a long file from disk. Resolves to false if it
   * cannot (the file is not a WAV at the device's sample rate, say), in
   * which case the audio should be handed over with `loadAsset` instead.
   * The paths are as for `StudioBridge.readAudioFile`.
   */
  openStream(assetId: Id, projectPath: string | null, assetPath: string): Promise<boolean>
  /** Renders the project the engine currently has to a WAV file, faster than real time, and resolves to its bytes. */
  render(): Promise<ArrayBuffer>
  /** Opens the audio input for a track, or closes it (null). Rejects if there is no input or access is refused. */
  setInput(trackId: Id | null, monitor: boolean): Promise<void>
  latency(): Promise<NativeLatency>
  /**
   * Measures the recording latency by playing a test sound and listening for
   * it (the input must be able to hear the output), and keeps the result for
   * these devices. Rejects, changing nothing, if the sound is not heard clearly.
   */
  calibrateLatency(): Promise<NativeLatency>
  /** Forgets the measurement for the devices in use. */
  clearLatency(): Promise<NativeLatency>
  /** Ends the take begun by a `play` command with `capture`. Null if nothing was captured. */
  stopRecording(): Promise<NativeTake | null>
  /**
   * The installed plugins as the last scan found them (kept between
   * sessions); null if there has never been one. With `rescan` they are
   * looked for afresh first, which can take minutes.
   */
  plugins(rescan: boolean): Promise<NativePlugins | null>
  onEvent(handler: (event: NativeEvent) => void): void
}
