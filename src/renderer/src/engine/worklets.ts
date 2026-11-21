/** Main-thread handles for the audio worklet processors in ./dsp/processors.ts. */
import { effectParam, EFFECTS } from '@shared/effects'
import { DEFAULT_SAMPLER, DEFAULT_SYNTH, type Effect, type Id, type Track } from '@shared/model'
import processorsUrl from './dsp/processors.ts?worker&url'
import type { EffectConfig, EffectsMessage, InstrumentConfig, InstrumentMessage, InstrumentOptions, NoteEvent, SampleData } from './dsp/protocol'

const loaded = new WeakMap<BaseAudioContext, Promise<void>>()

/** Loads the processors into a context. Must finish before any of the nodes below are created. */
export function loadWorklets(ctx: BaseAudioContext): Promise<void> {
  let promise = loaded.get(ctx)
  if (!promise) {
    promise = ctx.audioWorklet.addModule(processorsUrl)
    loaded.set(ctx, promise)
  }
  return promise
}

export function instrumentConfig(track: Track): InstrumentConfig {
  const sampler = track.sampler ?? DEFAULT_SAMPLER
  return {
    instrument: track.instrument ?? 'synth',
    synth: track.synth ?? DEFAULT_SYNTH,
    sampler: { sampleId: sampler.assetId, root: sampler.root, attack: sampler.attack, release: sampler.release }
  }
}

export function sampleData(id: Id, buffer: AudioBuffer): SampleData {
  return {
    id,
    sampleRate: buffer.sampleRate,
    channels: Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c))
  }
}

export function effectConfigs(effects: readonly Effect[]): EffectConfig[] {
  // Plugins are not Web Audio's to run.
  return effects.flatMap((effect) =>
    effect.type === 'plugin'
      ? []
      : {
          id: effect.id,
          type: effect.type,
          // Fill in defaults so the audio thread never meets a missing value.
          params: Object.fromEntries(EFFECTS[effect.type].params.map((p) => [p.key, effectParam(effect, p.key)]))
        }
  )
}

/** A track's instrument. Its output is the instrument's sound in stereo. */
export class InstrumentNode {
  readonly node: AudioWorkletNode

  constructor(ctx: BaseAudioContext, options: InstrumentOptions) {
    this.node = new AudioWorkletNode(ctx, 'studio-instrument', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: options
    })
  }

  private send(message: InstrumentMessage): void {
    this.node.port.postMessage(message)
  }

  configure(config: InstrumentConfig): void {
    this.send({ type: 'config', config })
  }

  loadSample(sample: SampleData): void {
    this.send({ type: 'sample', sample })
  }

  note(note: NoteEvent): void {
    this.send({ type: 'note', note })
  }

  off(id: number): void {
    this.send({ type: 'off', id })
  }

  /** Silences everything the sequencer started or queued; notes played by hand carry on. */
  stop(): void {
    this.send({ type: 'stop' })
  }
}

/** A track's insert effects: stereo in, stereo out. */
export class EffectsNode {
  readonly node: AudioWorkletNode

  constructor(ctx: BaseAudioContext, effects: EffectConfig[]) {
    this.node = new AudioWorkletNode(ctx, 'studio-effects', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: { effects }
    })
  }

  setChain(effects: EffectConfig[]): void {
    const message: EffectsMessage = { type: 'chain', effects }
    this.node.port.postMessage(message)
  }
}

/** Measures the peak level of whatever is connected to it. */
export class MeterNode {
  readonly node: AudioWorkletNode
  /** The most recent reading, 0–1+. */
  peak = 0

  constructor(ctx: BaseAudioContext) {
    this.node = new AudioWorkletNode(ctx, 'studio-meter', { numberOfInputs: 1, numberOfOutputs: 0 })
    this.node.port.onmessage = (event: MessageEvent<number>) => (this.peak = event.data)
  }
}
