/**
 * What the main thread and the audio worklets say to each other. Types only:
 * this file is imported on both sides.
 */
import type { BuiltInEffectType, InstrumentType, SynthParams } from '@shared/model'

export interface InstrumentConfig {
  instrument: InstrumentType
  synth: SynthParams
  sampler: { sampleId: string | null; root: number; attack: number; release: number }
}

export interface SampleData {
  id: string
  channels: Float32Array[]
  sampleRate: number
}

export interface NoteEvent {
  id: number
  pitch: number
  velocity: number
  /** Audio-clock time the note starts; anything in the past starts at once. */
  time: number
  /** Seconds until release; null holds the note until an 'off' message. */
  duration: number | null
  /** Played by hand rather than by the sequencer, so 'stop' leaves it sounding. */
  live?: boolean
}

export type InstrumentMessage =
  | { type: 'config'; config: InstrumentConfig }
  | { type: 'sample'; sample: SampleData }
  | { type: 'note'; note: NoteEvent }
  | { type: 'off'; id: number }
  /** Silence everything the sequencer started or queued. */
  | { type: 'stop' }

/**
 * Everything an instrument needs up front. An offline render cannot rely on
 * messages arriving in time, so there the whole performance is passed here.
 */
export interface InstrumentOptions {
  config: InstrumentConfig
  samples: SampleData[]
  notes: NoteEvent[]
}

export interface EffectConfig {
  id: string
  type: BuiltInEffectType
  params: Record<string, number>
}

export type EffectsMessage = { type: 'chain'; effects: EffectConfig[] }

export interface EffectsOptions {
  effects: EffectConfig[]
}
