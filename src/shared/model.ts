/**
 * The project model. Plain, serialisable data only: this is what gets saved to
 * disk, kept in undo history, and sent to the audio engine.
 *
 * All musical positions and lengths are in ticks (see PPQ).
 */

/** Ticks per quarter note. */
export const PPQ = 960

export type Id = string

export interface Note {
  id: Id
  /** MIDI note number, 0–127. */
  pitch: number
  /** Ticks from the start of the owning clip. */
  start: number
  length: number
  /** 0–1. */
  velocity: number
}

interface ClipBase {
  id: Id
  name: string
  /** Position on the timeline, in ticks. */
  start: number
  length: number
}

export interface MidiClip extends ClipBase {
  kind: 'midi'
  notes: Note[]
}

export interface AudioClip extends ClipBase {
  kind: 'audio'
  assetId: Id
  /** Seconds into the source file where the clip begins. */
  offset: number
  /** Linear gain; 1 when absent. */
  gain?: number
  /** Fade lengths in seconds; 0 when absent. */
  fadeIn?: number
  fadeOut?: number
  /** Length multiplier without changing pitch: 2 plays at half speed. 1 when absent. */
  stretch?: number
  /** Pitch shift in semitones without changing length. 0 when absent. */
  pitch?: number
}

export type Clip = MidiClip | AudioClip

export type Waveform = 'sine' | 'triangle' | 'sawtooth' | 'square'

export interface SynthParams {
  wave: Waveform
  /** Seconds. */
  attack: number
  decay: number
  /** 0–1. */
  sustain: number
  release: number
  /** Low-pass cutoff in Hz. */
  cutoff: number
  resonance: number
}

/**
 * 'plugin' is a VST3 or Audio Unit instrument (`Track.plugin`), 'soundfont' a preset of the bundled
 * SoundFont (`Track.soundfont`) and 'sfz' an SFZ instrument from the content folder (`Track.sfz`).
 * Only the native engine can play those three.
 */
export type InstrumentType = 'synth' | 'drums' | 'sampler' | 'plugin' | 'soundfont' | 'sfz'

/** An SFZ instrument: a file that maps samples across the keyboard, in the content folder. */
export interface SfzInstrument {
  /** Its path within the content folder, with forward slashes: `sfz/Some Pack/Programs/Piano.sfz`. */
  file: string
  /** The file's name without `.sfz`; kept so the track can be labelled where the pack is not installed. */
  name: string
  /** The pack it belongs to: the folder directly under `sfz/`. */
  pack: string
}

/** One of Surge XT's patches, found on disk. */
export interface SurgePatch {
  name: string
  /** The folder it is filed under: Basses, Leads, Pads … */
  category: string
  /** 'Factory', or whoever made it. */
  author: string
  /** The .fxp file. */
  path: string
}

/** A preset of a SoundFont: an instrument such as a piano, or (in bank 128) a drum kit. */
export interface SoundFontPreset {
  bank: number
  /** The program number within the bank, 0-127. */
  program: number
  /** As the SoundFont names it; kept so the track can be labelled without the file to hand. */
  name: string
}

/** A VST3 or Audio Unit plugin, as the native engine's scan found it. */
export interface PluginRef {
  name: string
  manufacturer: string
  /** 'VST3' or 'AudioUnit'. */
  format: string
  /** It makes sound from notes, rather than processing audio. */
  instrument: boolean
  /** The engine's own record of the plugin, which is what it loads it from. Opaque to the app. */
  description: string
}

export interface SamplerParams {
  /** The sample to play; null until one is loaded. */
  assetId: Id | null
  /** The MIDI note at which the sample plays at its recorded pitch. */
  root: number
  /** Seconds. */
  attack: number
  release: number
}

export type BuiltInEffectType = 'eq' | 'compressor' | 'delay' | 'reverb'
/** 'plugin' is a VST3 or Audio Unit effect (`Effect.plugin`), which only the native engine can run. */
export type EffectType = BuiltInEffectType | 'plugin'

export interface Effect {
  id: Id
  type: EffectType
  bypass: boolean
  /** Values by parameter key; see EFFECTS in effects.ts for each built-in type's parameters. Empty for a plugin. */
  params: Record<string, number>
  /** Which plugin, when `type` is 'plugin'. */
  plugin?: PluginRef
  /** The plugin's settings as it last reported them (base64, in the plugin's own format); absent until they are changed. */
  state?: string
}

/** Sends a copy of a track's output, after its fader, to a bus. */
export interface Send {
  busId: Id
  /** Linear gain, 0–1. */
  level: number
}

export type AutomationTarget = 'volume' | 'pan'

export interface AutomationPoint {
  id: Id
  tick: number
  value: number
}

export const AUTOMATION_RANGE: Record<AutomationTarget, { min: number; max: number; label: string }> = {
  volume: { min: 0, max: 1.5, label: 'Volume' },
  pan: { min: -1, max: 1, label: 'Pan' }
}

export interface Track {
  id: Id
  name: string
  /** A bus holds no clips; it receives sends from other tracks. */
  kind: 'midi' | 'audio' | 'bus'
  color: string
  /** Linear gain, 0–1.5 (1 = unity). */
  volume: number
  /** -1 (left) to 1 (right). */
  pan: number
  mute: boolean
  solo: boolean
  /** Which instrument a MIDI track plays; 'synth' when absent. */
  instrument?: InstrumentType
  /** Present on MIDI tracks. */
  synth?: SynthParams
  sampler?: SamplerParams
  /** The instrument when `instrument` is 'plugin', and its settings (as `Effect.state`). */
  plugin?: PluginRef
  pluginState?: string
  /** The name of the patch the plugin instrument was last given from the app's own picker. Changing the sound in the plugin's window does not update it. */
  pluginPatch?: string
  /** The instrument when `instrument` is 'soundfont'. */
  soundfont?: SoundFontPreset
  /** The instrument when `instrument` is 'sfz'. */
  sfz?: SfzInstrument
  /** Insert effects, in signal order. */
  effects?: Effect[]
  sends?: Send[]
  /**
   * Breakpoints, sorted by tick, joined by straight lines. While playing, a
   * parameter with points follows them instead of the track's fixed value.
   */
  automation?: Partial<Record<AutomationTarget, AutomationPoint[]>>
  clips: Clip[]
}

export interface AudioAsset {
  id: Id
  name: string
  /**
   * Where the file lives: relative to the project folder once the project has
   * been saved (`audio/take.wav`), absolute before that. Absent when imported
   * in a plain browser.
   */
  path?: string
  /** Seconds. */
  duration: number
}

export interface LoopRegion {
  enabled: boolean
  start: number
  end: number
}

/** From `tick` onwards the tempo is `bpm` (quarter notes per minute), until the next change. */
export interface TempoChange {
  id: Id
  tick: number
  bpm: number
}

/** From bar `bar` (0-based) onwards the time signature is numerator/denominator. */
export interface MeterChange {
  id: Id
  bar: number
  numerator: number
  denominator: number
}

/** A named position on the timeline. */
export interface Marker {
  id: Id
  tick: number
  name: string
}

export interface Project {
  version: 1
  name: string
  /** Tempo at the start of the project. Use `timeMap(project)` for anything involving time. */
  bpm: number
  /** Time signature at the start of the project: beatsPerBar / beatUnit (4 when absent). */
  beatsPerBar: number
  beatUnit?: number
  /** Later tempo and time-signature changes. */
  tempoChanges?: TempoChange[]
  meterChanges?: MeterChange[]
  markers?: Marker[]
  loop: LoopRegion
  tracks: Track[]
  assets: Record<Id, AudioAsset>
}

export const DEFAULT_SYNTH: SynthParams = {
  wave: 'sawtooth',
  attack: 0.005,
  decay: 0.15,
  sustain: 0.6,
  release: 0.2,
  cutoff: 2400,
  resonance: 1
}

export const TRACK_COLORS = ['#5b9cf5', '#f5a35b', '#6fcf8a', '#d67bd8', '#e8d15a', '#5fd0cf', '#f07178']

export function newId(): Id {
  return Math.random().toString(36).slice(2, 10)
}

/** Tick position of the end of the last clip. */
export function projectEnd(project: Project): number {
  let end = 0
  for (const t of project.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.length)
  return end
}

export const DEFAULT_SAMPLER: SamplerParams = { assetId: null, root: 60, attack: 0.002, release: 0.15 }

/** The drum machine's sounds by pitch class (C, C#, D …), following General MIDI from C1. */
export const DRUM_NAMES = ['Kick', 'Rim', 'Snare', 'Clap', 'Snare 2', 'Tom L', 'Hat', 'Tom M', 'Hat 2', 'Tom H', 'Open hat', 'Cowbell']

/** Ids of every audio asset the project needs: those in clips and those loaded into samplers. */
export function usedAssetIds(project: Project): Set<Id> {
  const used = new Set<Id>()
  for (const track of project.tracks) {
    if (track.sampler?.assetId) used.add(track.sampler.assetId)
    for (const clip of track.clips) if (clip.kind === 'audio') used.add(clip.assetId)
  }
  return used
}

/** The value of an automation curve at a tick. Points must be sorted; the ends hold flat. */
export function automationValue(points: readonly AutomationPoint[], tick: number): number {
  if (tick <= points[0].tick) return points[0].value
  for (let i = 1; i < points.length; i++) {
    const b = points[i]
    if (tick <= b.tick) {
      const a = points[i - 1]
      return b.tick === a.tick ? b.value : a.value + ((b.value - a.value) * (tick - a.tick)) / (b.tick - a.tick)
    }
  }
  return points[points.length - 1].value
}

/**
 * How an audio clip's stretch and pitch settings are carried out: the source
 * is time-stretched by `ratio` (keeping its pitch), then played at speed
 * `rate`, which moves pitch and length together. The net effect is a length
 * multiplier of `stretch` and a pitch factor of `rate`.
 */
export function clipStretch(clip: AudioClip): { stretch: number; rate: number; ratio: number; key: string } {
  const stretch = clip.stretch ?? 1
  const rate = 2 ** ((clip.pitch ?? 0) / 12)
  const ratio = Math.round(stretch * rate * 1000) / 1000
  return { stretch, rate, ratio, key: `${clip.assetId}|${ratio}` }
}
