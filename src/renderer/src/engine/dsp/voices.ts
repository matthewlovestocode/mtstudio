/**
 * Instrument voices. Each renders one note by adding samples into a stereo
 * block. Plain arithmetic on arrays with no Web Audio calls, so the same code
 * could be compiled into a native engine.
 */
import type { SynthParams } from '@shared/model'
import { Biquad, type BiquadType } from './biquad'
import type { SampleData } from './protocol'

/** Below this an envelope is treated as finished. */
const SILENCE = 1e-4
/** Time constant for cutting a voice short without a click. */
const KILL_SECONDS = 0.01

/** Per-sample coefficient for an exponential approach with time constant `seconds`. */
const approach = (seconds: number, rate: number): number => 1 - Math.exp(-1 / (Math.max(seconds, 0.0005) * rate))

export interface Voice {
  readonly id: number
  readonly live: boolean
  /** Frame at which the note is released; Infinity while held. */
  offFrame: number
  /**
   * Adds frames [from, to) of the block, whose first frame is absolute frame
   * `blockFrame`. Returns false once the voice has finished.
   */
  render(left: Float32Array, right: Float32Array, from: number, to: number, blockFrame: number): boolean
  /** Fade out almost at once. */
  kill(): void
}

// ── Synth ────────────────────────────────────────────────────────────────

/** Band-limiting correction for the step in a sawtooth or square wave. */
function polyBlep(phase: number, step: number): number {
  if (phase < step) {
    const t = phase / step
    return t + t - t * t - 1
  }
  if (phase > 1 - step) {
    const t = (phase - 1) / step
    return t * t + t + t + 1
  }
  return 0
}

/** Holds the synth settings shared by a track's voices, so held notes follow the controls. */
export interface SynthSettings {
  params: SynthParams
  /** Bumped whenever `params` is replaced. */
  version: number
}

/** Oscillator → resonant low-pass → attack/decay/sustain/release envelope. */
export class SynthVoice implements Voice {
  offFrame = Infinity
  private phase = 0
  private step: number
  private filter = new Biquad()
  private seen = -1
  private level = 0
  private stage: 'attack' | 'decay' | 'release' = 'attack'
  private peak: number
  private releaseCoef = 0

  constructor(
    readonly id: number,
    readonly live: boolean,
    pitch: number,
    velocity: number,
    private settings: SynthSettings,
    private rate: number
  ) {
    this.step = (440 * 2 ** ((pitch - 69) / 12)) / rate
    this.peak = velocity * 0.3
  }

  kill(): void {
    this.stage = 'release'
    this.releaseCoef = approach(KILL_SECONDS, this.rate)
  }

  render(left: Float32Array, right: Float32Array, from: number, to: number, blockFrame: number): boolean {
    const { params, version } = this.settings
    if (version !== this.seen) {
      this.seen = version
      // Resonance is in decibels, as on the Web Audio low-pass filter this replaces.
      this.filter.set('lowpass', params.cutoff, 10 ** (params.resonance / 20), 0, this.rate)
    }
    const attackStep = this.peak / Math.max(1, params.attack * this.rate)
    const decayCoef = approach(params.decay / 3, this.rate)
    const sustain = this.peak * params.sustain
    const { step } = this

    for (let i = from; i < to; i++) {
      if (this.stage !== 'release' && blockFrame + i >= this.offFrame) {
        this.stage = 'release'
        this.releaseCoef = approach(params.release / 3, this.rate)
      }
      if (this.stage === 'attack') {
        this.level += attackStep
        if (this.level >= this.peak) {
          this.level = this.peak
          this.stage = 'decay'
        }
      } else if (this.stage === 'decay') {
        this.level += (sustain - this.level) * decayCoef
      } else {
        this.level -= this.level * this.releaseCoef
        if (this.level < SILENCE) return false
      }

      const p = this.phase
      let sample: number
      switch (params.wave) {
        case 'sine':
          sample = Math.sin(2 * Math.PI * p)
          break
        case 'triangle':
          sample = 4 * Math.abs(p - 0.5) - 1
          break
        case 'square':
          sample = (p < 0.5 ? 1 : -1) + polyBlep(p, step) - polyBlep((p + 0.5) % 1, step)
          break
        default:
          sample = 2 * p - 1 - polyBlep(p, step)
      }
      this.phase = p + step >= 1 ? p + step - 1 : p + step

      const out = this.filter.tick(sample) * this.level
      left[i] += out
      right[i] += out
    }
    return true
  }
}

// ── Sampler ──────────────────────────────────────────────────────────────

/** Plays a sample at a speed set by the note, with a simple attack and release. */
export class SampleVoice implements Voice {
  offFrame = Infinity
  private position = 0
  private step: number
  private level = 0
  private releasing = false
  private releaseCoef: number
  private attackStep: number

  constructor(
    readonly id: number,
    readonly live: boolean,
    pitch: number,
    private velocity: number,
    private sample: SampleData,
    settings: { root: number; attack: number; release: number },
    private rate: number
  ) {
    this.step = 2 ** ((pitch - settings.root) / 12) * (sample.sampleRate / rate)
    this.attackStep = velocity / Math.max(1, settings.attack * rate)
    this.releaseCoef = approach(settings.release / 3, rate)
  }

  kill(): void {
    this.releasing = true
    this.releaseCoef = approach(KILL_SECONDS, this.rate)
  }

  render(left: Float32Array, right: Float32Array, from: number, to: number, blockFrame: number): boolean {
    const a = this.sample.channels[0]
    const b = this.sample.channels[1] ?? a
    const last = a.length - 1
    for (let i = from; i < to; i++) {
      if (this.position >= last) return false
      if (!this.releasing && blockFrame + i >= this.offFrame) this.releasing = true
      if (this.releasing) {
        this.level -= this.level * this.releaseCoef
        if (this.level < SILENCE) return false
      } else if (this.level < this.velocity) {
        this.level = Math.min(this.velocity, this.level + this.attackStep)
      }
      // Linear interpolation between neighbouring samples.
      const index = this.position | 0
      const mix = this.position - index
      left[i] += (a[index] + (a[index + 1] - a[index]) * mix) * this.level
      right[i] += (b[index] + (b[index + 1] - b[index]) * mix) * this.level
      this.position += this.step
    }
    return true
  }
}

// ── Drums ────────────────────────────────────────────────────────────────

/** One layer of a drum sound: a swept tone or a burst of filtered noise. */
interface Layer {
  /** Seconds after the hit at which the layer starts. */
  delay: number
  level: number
  decay: number
  tone?: { wave: 'sine' | 'triangle' | 'square'; from: number; to: number; sweep: number }
  noise?: { type: BiquadType; frequency: number }
}

const tone = (wave: 'sine' | 'triangle' | 'square', from: number, to: number, sweep: number, level: number, decay: number): Layer => ({
  delay: 0,
  level,
  decay,
  tone: { wave, from, to, sweep }
})
const noise = (type: BiquadType, frequency: number, level: number, decay: number, delay = 0): Layer => ({
  delay,
  level,
  decay,
  noise: { type, frequency }
})
const tom = (frequency: number): Layer[] => [tone('sine', frequency * 1.5, frequency, 0.08, 0.8, 0.35)]

/** The kit, by pitch class (C, C#, D …), following General MIDI from C1. Names are in DRUM_NAMES. */
const KIT: Layer[][] = [
  [tone('sine', 160, 45, 0.11, 1, 0.42), noise('lowpass', 2500, 0.25, 0.015)], // kick
  [tone('triangle', 820, 400, 0.02, 0.5, 0.05), noise('bandpass', 2400, 0.4, 0.03)], // rim
  [tone('triangle', 220, 150, 0.06, 0.5, 0.13), noise('highpass', 1400, 0.55, 0.2)], // snare
  [
    // clap: three quick bursts, then a tail
    noise('bandpass', 1300, 0.6, 0.02),
    noise('bandpass', 1300, 0.6, 0.02, 0.012),
    noise('bandpass', 1300, 0.6, 0.02, 0.024),
    noise('bandpass', 1300, 0.5, 0.22, 0.034)
  ],
  [tone('triangle', 220, 150, 0.06, 0.5, 0.13), noise('highpass', 2200, 0.55, 0.2)], // snare 2
  tom(95),
  [noise('highpass', 7500, 0.35, 0.05)], // closed hat
  tom(135),
  [noise('highpass', 7500, 0.35, 0.09)], // hat 2
  tom(185),
  [noise('highpass', 7000, 0.32, 0.38)], // open hat
  [tone('square', 540, 540, 0.01, 0.2, 0.28), tone('square', 800, 800, 0.01, 0.2, 0.28)] // cowbell
]

interface ActiveLayer {
  layer: Layer
  filter: Biquad | null
  phase: number
}

/** A synthesised drum hit. Plays out on its own; note-off does nothing. */
export class DrumVoice implements Voice {
  offFrame = Infinity
  readonly live = false
  private layers: ActiveLayer[]
  private frame = 0
  private length: number
  private gain: number
  private killCoef = 0

  constructor(
    readonly id: number,
    pitch: number,
    velocity: number,
    private rate: number
  ) {
    const recipe = KIT[((pitch % 12) + 12) % 12]
    this.gain = velocity
    this.length = Math.max(...recipe.map((l) => l.delay + l.decay)) * rate
    this.layers = recipe.map((layer) => {
      let filter: Biquad | null = null
      if (layer.noise) {
        filter = new Biquad()
        filter.set(layer.noise.type, layer.noise.frequency, 1, 0, rate)
      }
      return { layer, filter, phase: 0 }
    })
  }

  kill(): void {
    this.killCoef = approach(KILL_SECONDS, this.rate)
  }

  render(left: Float32Array, right: Float32Array, from: number, to: number): boolean {
    for (let i = from; i < to; i++) {
      if (this.frame >= this.length) return false
      if (this.killCoef) {
        this.gain -= this.gain * this.killCoef
        if (this.gain < SILENCE) return false
      }
      const t = this.frame / this.rate
      let sample = 0
      for (const active of this.layers) {
        const { layer } = active
        const local = t - layer.delay
        if (local < 0 || local > layer.decay) continue
        // Exponential fall from `level` to 0.001 over `decay`.
        const envelope = layer.level * (0.001 / layer.level) ** (local / layer.decay)
        if (layer.tone) {
          const { wave, from: f0, to: f1, sweep } = layer.tone
          const frequency = local >= sweep ? f1 : f0 * (f1 / f0) ** (local / sweep)
          const p = active.phase
          const value = wave === 'sine' ? Math.sin(2 * Math.PI * p) : wave === 'triangle' ? 4 * Math.abs(p - 0.5) - 1 : p < 0.5 ? 1 : -1
          active.phase = (p + frequency / this.rate) % 1
          sample += value * envelope
        } else if (active.filter) {
          sample += active.filter.tick(Math.random() * 2 - 1) * envelope
        }
      }
      left[i] += sample * this.gain
      right[i] += sample * this.gain
      this.frame++
    }
    return true
  }
}
