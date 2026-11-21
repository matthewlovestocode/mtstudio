import { clipStretch, PPQ, projectEnd, type AudioClip, type Id, type Project } from '@shared/model'
import { sameTempo, timeMap, type TimeMap } from '@shared/timemap'
import { collectNotes, Graph, newNoteId, type ScheduleState } from './graph'
import type { AssetInfo, AudioEngine, AudioStream, RecordedTake } from './types'
import StretchWorker from './dsp/stretch.worker.ts?worker'
import type { StretchRequest, StretchResponse } from './dsp/stretch.worker'
import { encodeWav } from './wav'
import { loadWorklets } from './worklets'
// A real file rather than an inlined data: URL, which the page's content security policy would refuse.
import recorderWorkletUrl from './recorder.worklet.js?url&no-inline'

/** How far ahead of the audio clock events are scheduled, in seconds. */
const LOOKAHEAD = 0.12
/** How often the scheduler runs, in milliseconds. */
const INTERVAL = 25
/** Loops shorter than this are ignored, so the scheduler always makes progress. */
const MIN_LOOP = PPQ / 4
const PEAKS_PER_SECOND = 200
/** Seconds of silence rendered after the last clip so release, delay and reverb tails are not cut short. */
const MIXDOWN_TAIL = 4

/**
 * Maps a moment on the audio clock to a musical position. From `time` the
 * playhead moves on from `tick` at the tempos in `map`.
 */
interface Anchor {
  time: number
  tick: number
  map: TimeMap
}

function tickAt(anchor: Anchor, time: number): number {
  return anchor.map.secondsToTick(anchor.map.tickToSeconds(anchor.tick) + Math.max(0, time - anchor.time))
}

interface Input {
  stream: MediaStream
  source: MediaStreamAudioSourceNode
  recorder: AudioWorkletNode
  monitor: GainNode
}

interface Capture {
  chunks: Float32Array[][]
  /** Audio-clock time of the first captured frame. */
  startTime: number | null
  /** The transport anchor in effect when recording began. */
  anchor: Anchor
}

export class WebAudioEngine implements AudioEngine {
  private ctx = new AudioContext({ latencyHint: 'interactive' })
  private buffers = new Map<Id, AudioBuffer>()
  /** Long files played from disk instead of from `buffers`. */
  private streams = new Map<Id, AudioStream>()
  /** Null until the audio worklets have loaded. */
  private graph: Graph | null = null
  private ready: Promise<void>
  private project: Project | null = null

  private playing = false
  /** Playhead position while stopped. */
  private position = 0
  private anchors: Anchor[] = []
  /** Everything before this audio-clock time / tick has been scheduled. */
  private schedTime = 0
  private schedTick = 0
  private timer: ReturnType<typeof setInterval> | null = null

  private scheduled: ScheduleState = { clips: new Map(), metronome: false }
  /** Notes being held by hand, by track and pitch. */
  private liveNotes = new Map<string, number>()
  private listeners = new Set<(playing: boolean) => void>()

  /** Time-stretched copies of audio files, by `clipStretch(clip).key`. */
  private stretched = new Map<string, AudioBuffer>()
  private stretching = new Map<string, Promise<void>>()
  private stretchWorker: Worker | null = null
  private stretchJobs = new Map<number, (channels: Float32Array[]) => void>()
  private stretchTimer: ReturnType<typeof setTimeout> | null = null

  private input: Input | null = null
  private workletReady: Promise<void> | null = null
  private recording = false
  private capture: Capture | null = null

  constructor() {
    // The mixer is built from worklet nodes, so it has to wait for their code to load.
    this.ready = loadWorklets(this.ctx).then(
      () => {
        this.graph = new Graph(this.ctx, this.buffers, { meters: true, stretched: this.stretched, streams: this.streams })
        if (this.project) this.graph.sync(this.project)
      },
      (error: unknown) => console.error('Studio could not load its audio processors.', error)
    )
  }

  // ── Project ────────────────────────────────────────────────────────────

  setProject(project: Project): void {
    const previous = this.project
    this.project = project
    this.graph?.sync(project)
    // Prepare stretched audio shortly after the edits settle, not on every step of a slider drag.
    if (this.stretchTimer) clearTimeout(this.stretchTimer)
    this.stretchTimer = setTimeout(() => void this.prepareStretches(project), 250)
    if (!this.playing || !previous) return

    if (!sameTempo(previous, project)) {
      // What is already scheduled keeps its old tempo; the new one starts from there.
      this.anchors.push({ time: this.schedTime, tick: this.schedTick, map: timeMap(project) })
    }

    // Stop audio clips that were edited or removed; the scheduler restarts any that still apply.
    const current = new Map<Id, AudioClip>()
    for (const track of project.tracks) {
      for (const clip of track.clips) if (clip.kind === 'audio') current.set(clip.id, clip)
    }
    for (const [id, playing] of this.scheduled.clips) {
      if (current.get(id) !== playing.clip) {
        playing.stop()
        this.scheduled.clips.delete(id)
      }
    }
  }

  // ── Assets ─────────────────────────────────────────────────────────────

  async loadAsset(assetId: Id, data: ArrayBuffer): Promise<AssetInfo> {
    const buffer = await this.ctx.decodeAudioData(data)
    this.buffers.set(assetId, buffer)
    // A sampler may have been waiting for this file.
    if (this.project) this.graph?.sync(this.project)

    const bucket = Math.max(1, Math.round(buffer.sampleRate / PEAKS_PER_SECOND))
    const count = Math.ceil(buffer.length / bucket)
    const peaks = new Float32Array(count * 2)
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c))
    for (let i = 0; i < count; i++) {
      let min = 0
      let max = 0
      const end = Math.min(buffer.length, (i + 1) * bucket)
      for (let s = i * bucket; s < end; s++) {
        let v = 0
        for (const channel of channels) v += channel[s]
        v /= channels.length
        if (v < min) min = v
        if (v > max) max = v
      }
      peaks[i * 2] = min
      peaks[i * 2 + 1] = max
    }
    return { duration: buffer.duration, peaks, secondsPerPeak: bucket / buffer.sampleRate }
  }

  loadAssetStream(assetId: Id, stream: AudioStream): void {
    this.streams.set(assetId, stream)
  }

  hasAsset(assetId: Id): boolean {
    return this.buffers.has(assetId) || this.streams.has(assetId)
  }

  /** The whole of an asset in memory. For a streamed file this reads all of it, so it is only for stretching and export. */
  private async fullBuffer(assetId: Id): Promise<AudioBuffer | undefined> {
    const buffer = this.buffers.get(assetId)
    const stream = this.streams.get(assetId)
    if (buffer || !stream) return buffer
    const channels = await stream.read(0, stream.frames)
    const out = this.ctx.createBuffer(channels.length, channels[0].length, stream.sampleRate)
    channels.forEach((channel, c) => out.copyToChannel(channel as Float32Array<ArrayBuffer>, c))
    return out
  }

  // ── Time-stretch ───────────────────────────────────────────────────────

  /** Makes sure every stretched or repitched clip has its processed audio. Resolves when all are ready. */
  private prepareStretches(project: Project): Promise<unknown> {
    const jobs: Promise<void>[] = []
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.kind !== 'audio') continue
        const { ratio, key } = clipStretch(clip)
        if (ratio === 1 || !this.hasAsset(clip.assetId) || this.stretched.has(key)) continue
        let job = this.stretching.get(key)
        if (!job) {
          job = this.fullBuffer(clip.assetId).then(async (buffer) => {
            if (buffer) this.stretched.set(key, await this.stretch(buffer, ratio))
            this.stretching.delete(key)
          })
          this.stretching.set(key, job)
        }
        jobs.push(job)
      }
    }
    return Promise.all(jobs)
  }

  private async stretch(buffer: AudioBuffer, ratio: number): Promise<AudioBuffer> {
    if (!this.stretchWorker) {
      this.stretchWorker = new StretchWorker()
      this.stretchWorker.onmessage = (event: MessageEvent<StretchResponse>) => {
        this.stretchJobs.get(event.data.id)?.(event.data.channels)
        this.stretchJobs.delete(event.data.id)
      }
    }
    const id = this.stretchJobs.size + Math.floor(Math.random() * 1e9)
    const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c).slice())
    const request: StretchRequest = { id, channels, ratio, rate: buffer.sampleRate }
    const result = await new Promise<Float32Array[]>((resolve) => {
      this.stretchJobs.set(id, resolve)
      this.stretchWorker!.postMessage(request, channels.map((c) => c.buffer))
    })
    const out = this.ctx.createBuffer(result.length, result[0].length, buffer.sampleRate)
    result.forEach((channel, c) => out.copyToChannel(channel as Float32Array<ArrayBuffer>, c))
    return out
  }

  // ── Transport ──────────────────────────────────────────────────────────

  async play(): Promise<void> {
    if (this.playing || !this.project) return
    await Promise.all([this.ctx.resume(), this.ready])
    if (this.playing || !this.graph) return
    this.playing = true
    this.graph.running = true
    this.startSchedulingFrom(this.position, 0.05)
    this.timer = setInterval(() => this.schedule(), INTERVAL)
    this.schedule()
    this.emit()
  }

  stop(): void {
    if (!this.playing) return
    this.position = this.getPosition()
    this.playing = false
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    this.silenceScheduled()
    // Hand automated parameters back to the faders.
    if (this.graph) this.graph.running = false
    if (this.project) this.graph?.sync(this.project)
    // A plain stop abandons any recording in progress.
    if (this.recording) {
      this.recording = false
      this.capture = null
      this.input?.recorder.port.postMessage('stop')
    }
    this.emit()
  }

  seek(tick: number): void {
    const target = Math.max(0, tick)
    if (!this.playing) {
      this.position = target
      return
    }
    // The playhead cannot jump mid-take.
    if (this.recording) return
    this.silenceScheduled()
    this.startSchedulingFrom(target, 0.03)
    this.schedule()
  }

  isPlaying(): boolean {
    return this.playing
  }

  getPosition(): number {
    if (!this.playing) return this.position
    const now = this.ctx.currentTime
    // Drop anchors that have been superseded.
    while (this.anchors.length > 1 && this.anchors[1].time <= now) this.anchors.shift()
    const anchor = this.anchors[0]
    return tickAt(anchor, now)
  }

  setMetronome(enabled: boolean): void {
    this.scheduled.metronome = enabled
  }

  onTransport(listener: (playing: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener(this.playing)
  }

  private startSchedulingFrom(tick: number, delay: number): void {
    this.schedTime = this.ctx.currentTime + delay
    this.schedTick = tick
    this.anchors = [{ time: this.schedTime, tick, map: timeMap(this.project!) }]
  }

  // ── Scheduler ──────────────────────────────────────────────────────────

  /** Schedules everything between the last scheduled point and now + LOOKAHEAD. */
  private schedule(): void {
    const { project, graph } = this
    if (!project || !graph || !this.playing) return
    const { loop } = project
    const map = timeMap(project)
    const horizon = this.ctx.currentTime + LOOKAHEAD
    const looping = loop.enabled && loop.end - loop.start >= MIN_LOOP && !this.recording

    while (this.schedTime < horizon) {
      let endTime = horizon
      let endTick = map.secondsToTick(map.tickToSeconds(this.schedTick) + (horizon - this.schedTime))
      const wrap = looping && this.schedTick < loop.end && endTick >= loop.end
      if (wrap) {
        endTick = loop.end
        endTime = this.schedTime + map.duration(this.schedTick, loop.end)
      }
      graph.scheduleSegment(project, this.schedTick, endTick, this.schedTime, this.scheduled)
      this.schedTick = endTick
      this.schedTime = endTime
      if (wrap) {
        for (const playing of this.scheduled.clips.values()) playing.stop(endTime)
        this.scheduled.clips.clear()
        this.schedTick = loop.start
        this.anchors.push({ time: endTime, tick: loop.start, map })
      }
    }
  }

  private silenceScheduled(): void {
    this.graph?.stopNotes()
    for (const playing of this.scheduled.clips.values()) playing.stop()
    this.scheduled.clips.clear()
  }

  // ── Live notes ─────────────────────────────────────────────────────────

  noteOn(trackId: Id, pitch: number, velocity: number): void {
    const instrument = this.graph?.strips.get(trackId)?.instrument
    if (!instrument) return
    void this.ctx.resume()
    this.noteOff(trackId, pitch)
    const id = newNoteId()
    instrument.note({ id, pitch, velocity, time: 0, duration: null, live: true })
    this.liveNotes.set(`${trackId}:${pitch}`, id)
  }

  noteOff(trackId: Id, pitch: number): void {
    const key = `${trackId}:${pitch}`
    const id = this.liveNotes.get(key)
    if (id === undefined) return
    this.liveNotes.delete(key)
    this.graph?.strips.get(trackId)?.instrument?.off(id)
  }

  // ── Input and recording ────────────────────────────────────────────────

  async setInput(trackId: Id | null, monitor: boolean): Promise<void> {
    if (!trackId) {
      if (!this.input) return
      this.input.source.disconnect()
      this.input.monitor.disconnect()
      for (const track of this.input.stream.getTracks()) track.stop()
      this.input = null
      return
    }

    if (!this.input) {
      // Raw input: the browser's voice-call processing would mangle music.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
      })
      this.workletReady ??= this.ctx.audioWorklet.addModule(recorderWorkletUrl)
      await this.workletReady
      await this.ctx.resume()
      const source = this.ctx.createMediaStreamSource(stream)
      const recorder = new AudioWorkletNode(this.ctx, 'recorder', { numberOfInputs: 1, numberOfOutputs: 0 })
      const gain = this.ctx.createGain()
      source.connect(recorder)
      source.connect(gain)
      this.input = { stream, source, recorder, monitor: gain }
    }

    this.input.monitor.disconnect()
    const strip = this.graph?.strips.get(trackId)
    if (monitor && strip) this.input.monitor.connect(strip.input)
  }

  async startRecording(captureAudio: boolean): Promise<void> {
    if (this.recording || !this.project) return
    if (captureAudio && !this.input) throw new Error('No audio input is open.')
    this.recording = true
    await this.play()

    if (!captureAudio || !this.input) return
    const capture: Capture = { chunks: [], startTime: null, anchor: this.currentAnchor() }
    this.capture = capture
    const { port } = this.input.recorder
    port.onmessage = (event: MessageEvent<{ type: string; time: number; channels: Float32Array[] }>) => {
      if (event.data.type !== 'chunk') return
      capture.startTime ??= event.data.time
      capture.chunks.push(event.data.channels)
    }
    port.postMessage('start')
  }

  async stopRecording(): Promise<RecordedTake | null> {
    if (!this.recording) return null
    const capture = this.capture
    const input = this.input
    this.recording = false
    this.capture = null

    let take: RecordedTake | null = null
    if (capture && input) {
      // Wait for the worklet to hand over its last partial batch.
      await new Promise<void>((resolve) => {
        const { port } = input.recorder
        const previous = port.onmessage
        port.onmessage = (event: MessageEvent) => {
          previous?.call(port, event)
          if ((event.data as { type: string }).type === 'done') resolve()
        }
        port.postMessage('stop')
      })
      take = this.finishTake(capture, input)
    }
    this.stop()
    return take
  }

  isRecording(): boolean {
    return this.recording
  }

  private currentAnchor(): Anchor {
    this.getPosition()
    return { ...this.anchors[0] }
  }

  private finishTake(capture: Capture, input: Input): RecordedTake | null {
    if (capture.startTime === null || !capture.chunks.length) return null
    const channelCount = capture.chunks[0].length
    const frames = capture.chunks.reduce((sum, chunk) => sum + chunk[0].length, 0)
    const channels = Array.from({ length: channelCount }, () => new Float32Array(frames))
    let written = 0
    for (const chunk of capture.chunks) {
      for (let c = 0; c < channelCount; c++) channels[c].set(chunk[c] ?? chunk[0], written)
      written += chunk[0].length
    }

    // A sound captured at time t was played against what the speakers put
    // out one round trip earlier, so that much is skipped at the front.
    const settings = input.stream.getAudioTracks()[0]?.getSettings() as (MediaTrackSettings & { latency?: number }) | undefined
    const inputLatency = settings?.latency ?? 0
    const latency = this.ctx.baseLatency + (this.ctx.outputLatency || 0) + inputLatency
    const { anchor } = capture
    const preRoll = Math.max(0, anchor.time - capture.startTime)
    const startTick = tickAt(anchor, capture.startTime)
    return { wav: encodeWav(channels, this.ctx.sampleRate, 'float32'), startTick, offset: preRoll + latency }
  }

  // ── Mixdown ────────────────────────────────────────────────────────────

  async renderMixdown(): Promise<ArrayBuffer> {
    const project = this.project
    const end = project ? projectEnd(project) : 0
    if (!project || end <= 0) throw new Error('There is nothing to export.')
    const sampleRate = this.ctx.sampleRate
    const seconds = timeMap(project).tickToSeconds(end) + MIXDOWN_TAIL
    const offline = new OfflineAudioContext(2, Math.ceil(seconds * sampleRate), sampleRate)
    await Promise.all([loadWorklets(offline), this.prepareStretches(project)])
    // An offline render cannot wait on the disk, so streamed files it uses are loaded whole for its duration.
    const buffers = new Map(this.buffers)
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.kind !== 'audio' || buffers.has(clip.assetId) || clipStretch(clip).ratio !== 1) continue
        const buffer = await this.fullBuffer(clip.assetId)
        if (buffer) buffers.set(clip.assetId, buffer)
      }
    }
    const graph = new Graph(offline, buffers, {
      meters: false,
      notes: collectNotes(project, 0, end, 0),
      stretched: this.stretched,
      streams: new Map()
    })
    graph.running = true
    graph.sync(project, true)
    graph.scheduleSegment(project, 0, end, 0, { clips: new Map(), metronome: false })
    const rendered = await offline.startRendering()
    return encodeWav([rendered.getChannelData(0), rendered.getChannelData(1)], sampleRate, 'pcm24')
  }

  // ── Metering ───────────────────────────────────────────────────────────

  getPeak(target: Id | 'master'): number {
    return this.graph?.peak(target) ?? 0
  }
}
