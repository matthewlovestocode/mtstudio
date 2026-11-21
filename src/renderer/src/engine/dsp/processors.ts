/**
 * The audio worklet entry point: the processors that run on the audio thread.
 * Bundled into one script and loaded by worklets.ts.
 */
import { createEffectDsp, type EffectDsp } from './effects'
import type { EffectConfig, EffectsMessage, EffectsOptions, InstrumentConfig, InstrumentMessage, InstrumentOptions, NoteEvent, SampleData } from './protocol'
import { DrumVoice, SampleVoice, SynthVoice, type SynthSettings, type Voice } from './voices'

const MAX_VOICES = 64
/** Frames between meter readings (about 23 a second at 48 kHz). */
const METER_WINDOW = 2048

/**
 * A polyphonic instrument: synth, drum machine or sampler. Notes arrive
 * stamped with the audio-clock time they should start and are begun on the
 * exact sample.
 */
class InstrumentProcessor extends AudioWorkletProcessor {
  private config: InstrumentConfig
  private synth: SynthSettings
  private samples = new Map<string, SampleData>()
  /** Notes waiting for their start time, earliest first. */
  private queue: { frame: number; note: NoteEvent }[] = []
  private voices: Voice[] = []

  constructor(options: { processorOptions: InstrumentOptions }) {
    super(options)
    const { config, samples, notes } = options.processorOptions
    this.config = config
    this.synth = { params: config.synth, version: 0 }
    for (const sample of samples) this.samples.set(sample.id, sample)
    for (const note of notes) this.enqueue(note)
    this.port.onmessage = (event: MessageEvent<InstrumentMessage>) => this.receive(event.data)
  }

  private receive(message: InstrumentMessage): void {
    switch (message.type) {
      case 'config':
        this.config = message.config
        this.synth.params = message.config.synth
        this.synth.version++
        break
      case 'sample':
        this.samples.set(message.sample.id, message.sample)
        break
      case 'note':
        this.enqueue(message.note)
        break
      case 'off': {
        const voice = this.voices.find((v) => v.id === message.id)
        if (voice) voice.offFrame = currentFrame
        // Released before it began: never start it.
        this.queue = this.queue.filter((q) => q.note.id !== message.id)
        break
      }
      case 'stop':
        this.queue = this.queue.filter((q) => q.note.live)
        for (const voice of this.voices) if (!voice.live) voice.kill()
    }
  }

  private enqueue(note: NoteEvent): void {
    const frame = Math.round(note.time * sampleRate)
    let index = this.queue.length
    while (index > 0 && this.queue[index - 1].frame > frame) index--
    this.queue.splice(index, 0, { frame, note })
  }

  private start(note: NoteEvent, frame: number): void {
    const { config } = this
    const live = !!note.live
    let voice: Voice | null = null
    if (config.instrument === 'drums') {
      voice = new DrumVoice(note.id, note.pitch, note.velocity, sampleRate)
    } else if (config.instrument === 'sampler') {
      const sample = config.sampler.sampleId ? this.samples.get(config.sampler.sampleId) : undefined
      if (sample) voice = new SampleVoice(note.id, live, note.pitch, note.velocity, sample, config.sampler, sampleRate)
    } else {
      voice = new SynthVoice(note.id, live, note.pitch, note.velocity, this.synth, sampleRate)
    }
    if (!voice) return
    if (note.duration !== null) voice.offFrame = frame + Math.max(1, Math.round(note.duration * sampleRate))
    // Out of voices: the oldest makes way.
    if (this.voices.length >= MAX_VOICES) this.voices.shift()
    this.voices.push(voice)
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const left = outputs[0][0]
    const right = outputs[0][1] ?? left
    const length = left.length
    const blockEnd = currentFrame + length

    // Voices already sounding fill the whole block.
    let kept = 0
    for (const voice of this.voices) {
      if (voice.render(left, right, 0, length, currentFrame)) this.voices[kept++] = voice
    }
    this.voices.length = kept

    // Notes due in this block start part-way through it, on their exact sample.
    while (this.queue.length && this.queue[0].frame < blockEnd) {
      const { frame, note } = this.queue.shift()!
      const at = Math.max(currentFrame, frame)
      this.start(note, at)
      const voice = this.voices[this.voices.length - 1]
      if (voice?.id === note.id && !voice.render(left, right, at - currentFrame, length, currentFrame)) this.voices.pop()
    }
    return true
  }
}

/** A track's insert effects, run one after another. */
class EffectsProcessor extends AudioWorkletProcessor {
  private chain: EffectDsp[] = []
  /** Effects by id, so one keeps its delay lines and reverb tail when others are added or removed. */
  private byId = new Map<string, { type: string; dsp: EffectDsp }>()

  constructor(options: { processorOptions: EffectsOptions }) {
    super(options)
    this.setChain(options.processorOptions.effects)
    this.port.onmessage = (event: MessageEvent<EffectsMessage>) => this.setChain(event.data.effects)
  }

  private setChain(effects: EffectConfig[]): void {
    const next = new Map<string, { type: string; dsp: EffectDsp }>()
    this.chain = effects.map((effect) => {
      let entry = this.byId.get(effect.id)
      if (!entry || entry.type !== effect.type) entry = { type: effect.type, dsp: createEffectDsp(effect.type, sampleRate) }
      entry.dsp.set(effect.params)
      next.set(effect.id, entry)
      return entry.dsp
    })
    this.byId = next
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const left = outputs[0][0]
    const right = outputs[0][1]
    // With nothing connected the input is empty, but delay and reverb tails still need to ring out.
    const input = inputs[0]
    if (input.length) {
      left.set(input[0])
      right.set(input[1] ?? input[0])
    }
    for (const effect of this.chain) effect.process(left, right)
    return true
  }
}

/** Reports the peak level of its input a couple of dozen times a second. */
class MeterProcessor extends AudioWorkletProcessor {
  private peak = 0
  private frames = 0
  private reported = 0

  process(inputs: Float32Array[][]): boolean {
    for (const channel of inputs[0]) {
      for (let i = 0; i < channel.length; i++) {
        const value = Math.abs(channel[i])
        if (value > this.peak) this.peak = value
      }
    }
    this.frames += 128
    if (this.frames >= METER_WINDOW) {
      // Stay quiet while nothing is changing.
      if (this.peak !== this.reported) this.port.postMessage(this.peak)
      this.reported = this.peak
      this.peak = 0
      this.frames = 0
    }
    return true
  }
}

registerProcessor('studio-instrument', InstrumentProcessor)
registerProcessor('studio-effects', EffectsProcessor)
registerProcessor('studio-meter', MeterProcessor)
