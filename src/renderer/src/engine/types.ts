import type { Id, Project } from '@shared/model'

/**
 * The boundary between the app and whatever makes sound.
 *
 * Everything that crosses it is plain serialisable data, so an implementation
 * can live in this process (Web Audio) or in a native process behind IPC.
 * The UI must not reach around this interface into Web Audio.
 */
export interface AudioEngine {
  /** Replace the engine's view of the project. Cheap to call on every edit. */
  setProject(project: Project): void

  /** Decode an audio file and make it playable under `assetId`. */
  loadAsset(assetId: Id, data: ArrayBuffer): Promise<AssetInfo>
  /**
   * Make a long file playable under `assetId` without loading it: the engine
   * reads pieces through `stream` as playback needs them.
   */
  loadAssetStream(assetId: Id, stream: AudioStream): void
  hasAsset(assetId: Id): boolean

  play(): Promise<void>
  stop(): void
  /** Move the playhead; keeps playing if already playing. */
  seek(tick: number): void
  isPlaying(): boolean
  /** Current playhead position in ticks. Safe to call every frame. */
  getPosition(): number

  setMetronome(enabled: boolean): void

  /**
   * Open the audio input and route it to a track (null closes it). With
   * `monitor` on, the input is heard through that track's channel strip.
   */
  setInput(trackId: Id | null, monitor: boolean): Promise<void>
  /**
   * Start the transport in recording mode: looping is suspended, and with
   * `captureAudio` the open input is recorded.
   */
  startRecording(captureAudio: boolean): Promise<void>
  /** Stop the transport. Resolves to the captured audio, if any was being captured. */
  stopRecording(): Promise<RecordedTake | null>
  isRecording(): boolean

  /** Render the whole project to a stereo 24-bit WAV file, faster than real time. */
  renderMixdown(): Promise<ArrayBuffer>

  /** Play a note immediately on a MIDI track (auditioning, live input). */
  noteOn(trackId: Id, pitch: number, velocity: number): void
  noteOff(trackId: Id, pitch: number): void

  /** Current peak level, 0–1+, for a track id or 'master'. Safe to call every frame. */
  getPeak(target: Id | 'master'): number

  /** Called whenever playback starts or stops. Returns an unsubscribe function. */
  onTransport(listener: (playing: boolean) => void): () => void
}

export interface AssetInfo {
  /** Seconds. */
  duration: number
  /** Interleaved min/max pairs, one pair per `secondsPerPeak`, mixed to mono. */
  peaks: Float32Array
  secondsPerPeak: number
}

export interface RecordedTake {
  /** The recording as a WAV file. */
  wav: ArrayBuffer
  /** Timeline position the take belongs at. */
  startTick: number
  /** Seconds to skip at the start of the file: pre-roll plus round-trip latency. */
  offset: number
}

/** A file that can be read a piece at a time. */
export interface AudioStream {
  sampleRate: number
  channels: number
  /** Length in sample frames. */
  frames: number
  /**
   * Where the audio is on disk, when it is: an engine that can read files
   * itself may play from there instead of through `read`. The path is as in
   * the project's asset table (relative to the project folder once saved).
   */
  file?: { projectPath: string | null; path: string }
  /** Resolves to one array per channel holding `count` frames from `frame` (fewer at the end of the file). */
  read(frame: number, count: number): Promise<Float32Array[]>
}
