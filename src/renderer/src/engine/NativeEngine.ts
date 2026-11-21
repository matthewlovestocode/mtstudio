import { projectEnd, type Id, type Project } from '@shared/model'
import type { NativeCommand, NativeEngineBridge, NativeEvent, NativeInput, NativeLatency, NativePlugins } from '@shared/nativeEngine'
import { timeMap } from '@shared/timemap'
import type { AssetInfo, AudioEngine, AudioStream, RecordedTake } from './types'
import { encodeWav } from './wav'

/** Frames read at a time when a long file is pulled into the engine. */
const STREAM_CHUNK = 1 << 20

/** The furthest the playhead is moved on without hearing from the engine, in seconds. */
const MAX_COAST = 0.1
/** A reported position this far from where the playhead is drawn makes it jump instead of easing, in seconds. */
const SNAP = 0.05

/** What the native engine is doing, for the badge in the transport bar. */
export interface NativeStatus {
  /** The audio output in use; null until the engine has reported in. */
  device: string | null
  /** Set when the engine has no audio output or has stopped running. */
  error: string | null
}

/**
 * `AudioEngine` backed by the native engine process (`native/`). Every call
 * becomes a message through the preload bridge; the playhead and meters come
 * back as a stream of state events (see `@shared/nativeEngine`).
 *
 * It plays audio clips and MIDI clips (synth, drum
 * machine, sampler) through each track's effects, fader, pan, mute, solo and
 * sends to buses, with volume and pan automation, the metronome, live notes,
 * meters, input monitoring, recording and mixdown: the whole of the
 * `AudioEngine` interface, and everything a project can hold. Beyond that
 * interface it hosts VST3 and Audio Unit plugins, which Web Audio cannot.
 */
export class NativeEngine implements AudioEngine {
  private project: Project | null = null
  /** The project has changed since it was last sent. */
  private stale = false
  private seq = 0

  private playing = false
  private recording = false
  /** The take in progress includes audio from the input. */
  private capturing = false
  private inputOpen = false
  /** Playhead position at `reportedAt` (a `performance.now()` time). */
  private position = 0
  private reportedAt = 0
  /** The next report is taken as it stands, with no easing. */
  private resync = true

  private peaks: Record<string, number> = {}
  /** Ids of the audio files the engine has decoded. */
  private assets = new Set<Id>()
  private listeners = new Set<(playing: boolean) => void>()

  private state: NativeStatus = { device: null, error: null }

  /** The settings the engine has for each plugin, by `pluginKey`: what was last sent to it or reported by it. */
  private pluginStates = new Map<string, string | null>()
  /** Why a plugin could not be loaded, by `pluginKey`. */
  private pluginErrors = new Map<string, string>()
  private pluginStateListeners = new Set<(trackId: Id, effectId: Id | null, state: string) => void>()
  private statusListeners = new Set<() => void>()

  constructor(private link: NativeEngineBridge) {
    link.onEvent((event) => this.receive(event))
    this.transport({ type: 'hello', seq: 0 })
  }

  // ── Link ───────────────────────────────────────────────────────────────

  /** Sends a command, after the latest project if that has not gone yet. */
  private send(command: NativeCommand): void {
    this.flush()
    this.link.send(command)
  }

  private transport(command: Extract<NativeCommand, { seq: number }>): void {
    this.send({ ...command, seq: ++this.seq })
  }

  private flush(): void {
    if (!this.stale || !this.project) return
    this.stale = false
    const { project } = this
    // Plugins' settings travel apart from the project, and only when they differ from what the engine has.
    const states: Extract<NativeCommand, { type: 'pluginState' }>[] = []
    const note = (trackId: Id, effectId: Id | null, state: string | undefined): void => {
      const key = pluginKey(trackId, effectId)
      if (this.pluginStates.get(key) === (state ?? null)) return
      this.pluginStates.set(key, state ?? null)
      states.push({ type: 'pluginState', trackId, effectId, state: state ?? null })
    }
    const tracks = project.tracks.map((track) => {
      const plugins = (track.effects ?? []).filter((e) => e.type === 'plugin')
      const instrument = track.instrument === 'plugin' && track.plugin !== undefined
      if (!plugins.length && !instrument) return track
      if (instrument) note(track.id, null, track.pluginState)
      for (const effect of plugins) note(track.id, effect.id, effect.state)
      return { ...track, pluginState: undefined, effects: track.effects?.map((e) => (e.state === undefined ? e : { ...e, state: undefined })) }
    })
    this.link.send({ type: 'setProject', project: { ...project, tracks } })
    for (const command of states) this.link.send(command)
  }

  private receive(event: NativeEvent): void {
    switch (event.type) {
      case 'state': {
        this.peaks = event.peaks
        // Reports from before the latest transport command describe a state that no longer holds.
        if (event.seq !== this.seq) return
        const now = performance.now()
        if (event.playing && this.playing && !this.resync && this.project) {
          // Reports arrive on the engine's block boundaries, not ours: ease towards them rather than jump.
          const drawn = this.getPosition()
          const map = timeMap(this.project)
          const error = map.duration(drawn, event.tick)
          this.position = Math.abs(error) > SNAP ? event.tick : drawn + (event.tick - drawn) * 0.15
        } else {
          this.position = event.tick
        }
        this.reportedAt = now
        this.resync = false
        if (event.playing !== this.playing) {
          this.playing = event.playing
          if (!event.playing) this.recording = false
          this.emit()
        }
        break
      }
      case 'ready':
        this.setStatus({ device: event.device ?? null, error: event.error ?? null })
        break
      case 'asset':
      case 'rendered':
      case 'input':
      case 'take':
      case 'calibrated':
      case 'stream':
        // Answered in the main process; never reaches here.
        if (event.error) console.error(`Native audio engine: ${event.error}`)
        // The engine may be freshly started (or this page reloaded): give it the project again.
        this.stale = this.project !== null
        this.flush()
        break
      case 'pluginState': {
        // Recorded as known first, so the project carrying it back to the engine sends nothing.
        this.pluginStates.set(pluginKey(event.trackId, event.effectId), event.state)
        for (const listener of this.pluginStateListeners) listener(event.trackId, event.effectId, event.state)
        break
      }
      case 'pluginStatus': {
        const key = pluginKey(event.trackId, event.effectId)
        if (event.error) {
          console.error(`Native audio engine: a plugin could not be loaded: ${event.error}`)
          this.pluginErrors.set(key, event.error)
        } else this.pluginErrors.delete(key)
        // A plugin loaded afresh has the settings it starts with, whatever was there before.
        this.pluginStates.delete(key)
        this.stale = this.project !== null
        setTimeout(() => this.flush(), 0)
        for (const listener of this.statusListeners) listener()
        break
      }
      case 'plugins':
        // Answered in the main process.
        break
      case 'error':
        console.error(`Native audio engine: ${event.message}`)
        break
      case 'exit':
        console.error(event.reason)
        this.setStatus({ error: event.reason })
        this.peaks = {}
        if (this.playing) {
          this.position = this.getPosition()
          this.playing = false
          this.recording = false
          this.emit()
        }
    }
  }

  // ── Status ─────────────────────────────────────────────────────────────

  status(): NativeStatus {
    return this.state
  }

  onStatus(listener: () => void): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private setStatus(change: Partial<NativeStatus>): void {
    this.state = { ...this.state, ...change }
    for (const listener of this.statusListeners) listener()
  }

  /** Throws if the engine cannot make sound at all. */
  private requireRunning(): void {
    if (this.state.error) throw new Error(this.state.error)
  }

  // ── Project ────────────────────────────────────────────────────────────

  setProject(project: Project): void {
    this.project = project
    // Many edits can land in one go (a slider drag): send the last of them.
    if (!this.stale) setTimeout(() => this.flush(), 0)
    this.stale = true
  }

  // ── Assets ─────────────────────────────────────────────────────────────

  /** The engine decodes the file and keeps it in memory, for audio clips and samplers alike. */
  async loadAsset(assetId: Id, data: ArrayBuffer): Promise<AssetInfo> {
    const { duration, secondsPerPeak, peaks } = await this.link.loadAsset(assetId, data)
    this.assets.add(assetId)
    return { duration, secondsPerPeak, peaks: new Float32Array(peaks) }
  }

  /**
   * A long file on disk is played from there by the engine itself, a block at
   * a time. If the engine cannot do that (the stream has no file behind it,
   * or the file is not at the device's sample rate) the audio is read
   * through to the end and loaded whole; its clips are silent until then.
   */
  loadAssetStream(assetId: Id, stream: AudioStream): void {
    this.assets.add(assetId)
    void (async () => {
      const { file } = stream
      if (file && (await this.link.openStream(assetId, file.projectPath, file.path))) return
      const channels = Array.from({ length: stream.channels }, () => new Float32Array(stream.frames))
      for (let frame = 0; frame < stream.frames; frame += STREAM_CHUNK) {
        const piece = await stream.read(frame, Math.min(STREAM_CHUNK, stream.frames - frame))
        piece.forEach((data, c) => channels[c]?.set(data, frame))
      }
      await this.link.loadAsset(assetId, encodeWav(channels, stream.sampleRate, 'float32'))
    })().catch((error: unknown) => {
      this.assets.delete(assetId)
      console.error(`The native audio engine could not load a long audio file: ${error instanceof Error ? error.message : String(error)}`)
    })
  }

  hasAsset(assetId: Id): boolean {
    return this.assets.has(assetId)
  }

  // ── Transport ──────────────────────────────────────────────────────────

  async play(): Promise<void> {
    this.start(false, false)
  }

  private start(ignoreLoop: boolean, capture: boolean): void {
    if (this.playing || !this.project) return
    this.requireRunning()
    this.transport({ type: 'play', seq: 0, ignoreLoop, capture })
    this.playing = true
    this.reportedAt = performance.now()
    this.resync = true
    this.emit()
  }

  stop(): void {
    if (!this.playing) return
    this.position = this.getPosition()
    this.playing = false
    this.recording = false
    // A plain stop abandons any take; the engine does the same on its side.
    this.capturing = false
    this.transport({ type: 'stop', seq: 0 })
    this.emit()
  }

  seek(tick: number): void {
    // The playhead cannot jump mid-take.
    if (this.recording) return
    this.position = Math.max(0, tick)
    this.reportedAt = performance.now()
    this.resync = true
    this.transport({ type: 'seek', seq: 0, tick: this.position })
  }

  isPlaying(): boolean {
    return this.playing
  }

  getPosition(): number {
    if (!this.playing || !this.project) return this.position
    // Between reports the playhead carries on at the project's tempo.
    const elapsed = Math.min(MAX_COAST, Math.max(0, (performance.now() - this.reportedAt) / 1000))
    const map = timeMap(this.project)
    const tick = map.secondsToTick(map.tickToSeconds(this.position) + elapsed)
    const { loop } = this.project
    const looping = loop.enabled && !this.recording && loop.end - loop.start >= 240
    return looping && this.position < loop.end && tick >= loop.end ? loop.start + (tick - loop.end) : tick
  }

  setMetronome(enabled: boolean): void {
    this.send({ type: 'setMetronome', enabled })
  }

  onTransport(listener: (playing: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.playing)
  }

  // ── Live notes ─────────────────────────────────────────────────────────

  noteOn(trackId: Id, pitch: number, velocity: number): void {
    this.send({ type: 'noteOn', trackId, pitch, velocity })
  }

  noteOff(trackId: Id, pitch: number): void {
    this.send({ type: 'noteOff', trackId, pitch })
  }

  // ── Input and recording ────────────────────────────────────────────────

  async setInput(trackId: Id | null, monitor: boolean): Promise<void> {
    // The monitored track is looked up in the project the engine holds, so that must be current.
    this.flush()
    try {
      await this.link.setInput(trackId, monitor)
    } catch (error) {
      this.inputOpen = false
      throw fail(unwrap(error, 'The audio input could not be opened.'))
    }
    this.inputOpen = trackId !== null
  }

  /** The audio inputs there are to record from. */
  inputs(): Promise<NativeInput[]> {
    return this.link.inputs().catch(() => [])
  }

  /** Chooses the input to record from (null for the system's default). It is opened when a track is next armed. */
  chooseInput(name: string | null): Promise<void> {
    return this.link.chooseInput(name)
  }

  /** Starts the transport with the loop ignored; with `captureAudio` the open input is recorded from that same frame. */
  async startRecording(captureAudio: boolean): Promise<void> {
    if (this.recording || !this.project) return
    if (captureAudio && !this.inputOpen) throw new Error('No audio input is open.')
    if (this.playing) this.stop()
    this.start(true, captureAudio)
    this.recording = true
    this.capturing = captureAudio
  }

  async stopRecording(): Promise<RecordedTake | null> {
    if (!this.recording) return null
    let take: RecordedTake | null = null
    if (this.capturing) {
      this.capturing = false
      try {
        take = await this.link.stopRecording()
      } catch (error) {
        this.stop()
        throw fail(unwrap(error, 'The recording could not be saved.'))
      }
    }
    this.stop()
    return take
  }

  // ── Recording latency ──────────────────────────────────────────────────

  /** How far takes are shifted to line up with the music, and where that figure comes from. */
  latency(): Promise<NativeLatency> {
    return this.link.latency()
  }

  /**
   * Measures the recording latency: stops the transport, plays a two-second
   * test sound and listens for it on the input. The result is kept for the
   * devices in use and applied to takes from then on.
   */
  async calibrateLatency(): Promise<NativeLatency> {
    if (this.recording) throw new Error('Stop recording before measuring.')
    this.requireRunning()
    if (this.playing) this.stop()
    this.flush()
    try {
      return await this.link.calibrateLatency()
    } catch (error) {
      throw unwrap(error, 'The measurement failed.')
    }
  }

  clearLatency(): Promise<NativeLatency> {
    return this.link.clearLatency()
  }

  isRecording(): boolean {
    return this.recording
  }

  // ── Mixdown ────────────────────────────────────────────────────────────

  /** The engine renders on a thread of its own, with fresh strips and effects, so playback carries on untouched. */
  async renderMixdown(): Promise<ArrayBuffer> {
    if (!this.project || projectEnd(this.project) <= 0) throw new Error('There is nothing to export.')
    this.requireRunning()
    // The engine renders the project it holds, so it must have the latest.
    this.flush()
    try {
      return await this.link.render()
    } catch (error) {
      throw unwrap(error, 'The export failed.')
    }
  }

  // ── Plugins ────────────────────────────────────────────────────────────

  /** The installed VST3 and Audio Unit plugins as last scanned for (null if never). With `rescan` they are looked for afresh, which can take minutes. */
  async plugins(rescan = false): Promise<NativePlugins | null> {
    try {
      return await this.link.plugins(rescan)
    } catch (error) {
      throw unwrap(error, 'Could not look for plugins.')
    }
  }

  /** Opens a plugin's own window (the engine's, not the app's). `effectId` is null for a track's instrument. */
  showPlugin(trackId: Id, effectId: Id | null): void {
    this.send({ type: 'showPlugin', trackId, effectId })
  }

  /** Why a plugin the project names could not be loaded; null if it was (or has not been tried yet). Changes are announced through `onStatus`. */
  pluginError(trackId: Id, effectId: Id | null): string | null {
    return this.pluginErrors.get(pluginKey(trackId, effectId)) ?? null
  }

  /** Called when a plugin's settings change in its window, so the project can record them. */
  onPluginState(listener: (trackId: Id, effectId: Id | null, state: string) => void): () => void {
    this.pluginStateListeners.add(listener)
    return () => this.pluginStateListeners.delete(listener)
  }

  // ── Metering ───────────────────────────────────────────────────────────

  getPeak(target: Id | 'master'): number {
    return this.peaks[target] ?? 0
  }
}

function pluginKey(trackId: Id, effectId: Id | null): string {
  return `${trackId}/${effectId ?? 'instrument'}`
}

/** An error from the main process, without the wrapper Electron puts around it. */
function unwrap(error: unknown, fallback: string): Error {
  return new Error(error instanceof Error ? error.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback)
}

/** Logs an error on its way out, since not every caller reports what it catches. */
function fail(error: Error): Error {
  console.error(error.message)
  return error
}
