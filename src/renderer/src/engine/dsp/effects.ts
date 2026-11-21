/**
 * Insert effects. Each processes a stereo block in place. Parameter keys match
 * EFFECTS in src/shared/effects.ts.
 */
import type { BuiltInEffectType } from '@shared/model'
import { Biquad } from './biquad'

export interface EffectDsp {
  set(params: Record<string, number>): void
  process(left: Float32Array, right: Float32Array): void
}

export function createEffectDsp(type: BuiltInEffectType, rate: number): EffectDsp {
  switch (type) {
    case 'eq':
      return new Eq(rate)
    case 'compressor':
      return new Compressor(rate)
    case 'delay':
      return new Delay(rate)
    case 'reverb':
      return new Reverb(rate)
  }
}

/** Three bands: low shelf at 200 Hz, sweepable mid bell, high shelf at 4 kHz. */
class Eq implements EffectDsp {
  private bands = [0, 1].map(() => [new Biquad(), new Biquad(), new Biquad()])
  constructor(private rate: number) {}

  set(p: Record<string, number>): void {
    for (const [low, mid, high] of this.bands) {
      low.set('lowshelf', 200, 1, p.low, this.rate)
      mid.set('peaking', p.midFreq, 1, p.mid, this.rate)
      high.set('highshelf', 4000, 1, p.high, this.rate)
    }
  }

  process(left: Float32Array, right: Float32Array): void {
    const [l, r] = this.bands
    for (let i = 0; i < left.length; i++) {
      left[i] = l[2].tick(l[1].tick(l[0].tick(left[i])))
      right[i] = r[2].tick(r[1].tick(r[0].tick(right[i])))
    }
  }
}

/** Feed-forward compressor with a soft knee; both channels share one gain so the image stays put. */
class Compressor implements EffectDsp {
  private threshold = -18
  private ratio = 4
  private attackCoef = 0
  private releaseCoef = 0
  private makeup = 1
  /** Current gain reduction in dB (0 or negative). */
  private reduction = 0
  private readonly knee = 6

  constructor(private rate: number) {}

  set(p: Record<string, number>): void {
    this.threshold = p.threshold
    this.ratio = p.ratio
    this.attackCoef = 1 - Math.exp(-1 / (Math.max(p.attack, 0.0005) * this.rate))
    this.releaseCoef = 1 - Math.exp(-1 / (Math.max(p.release, 0.005) * this.rate))
    this.makeup = 10 ** (p.makeup / 20)
  }

  process(left: Float32Array, right: Float32Array): void {
    const { threshold, knee } = this
    const slope = 1 / this.ratio - 1
    for (let i = 0; i < left.length; i++) {
      const peak = Math.max(Math.abs(left[i]), Math.abs(right[i]))
      const level = peak > 1e-6 ? 20 * Math.log10(peak) : -120
      const over = level - threshold
      let target = 0
      if (over > knee / 2) target = slope * over
      else if (over > -knee / 2) target = (slope * (over + knee / 2) ** 2) / (2 * knee)
      // Clamp down fast (attack), let go slowly (release).
      this.reduction += (target - this.reduction) * (target < this.reduction ? this.attackCoef : this.releaseCoef)
      const gain = 10 ** (this.reduction / 20) * this.makeup
      left[i] *= gain
      right[i] *= gain
    }
  }
}

/** Feedback delay with a dry/wet mix. */
class Delay implements EffectDsp {
  private buffers: Float32Array[]
  private write = 0
  private samples = 0
  private target = 0
  private feedback = 0
  private mix = 0

  constructor(private rate: number) {
    this.buffers = [0, 1].map(() => new Float32Array(Math.ceil(rate * 2) + 2))
  }

  set(p: Record<string, number>): void {
    this.target = p.time * this.rate
    if (!this.samples) this.samples = this.target
    this.feedback = p.feedback
    this.mix = p.mix
  }

  process(left: Float32Array, right: Float32Array): void {
    const [bl, br] = this.buffers
    const size = bl.length
    for (let i = 0; i < left.length; i++) {
      // Glide to a new delay time rather than jumping, which would click.
      this.samples += (this.target - this.samples) * 0.0005
      let read = this.write - this.samples
      if (read < 0) read += size
      const index = read | 0
      const next = index + 1 === size ? 0 : index + 1
      const frac = read - index
      const dl = bl[index] + (bl[next] - bl[index]) * frac
      const dr = br[index] + (br[next] - br[index]) * frac
      bl[this.write] = left[i] + dl * this.feedback
      br[this.write] = right[i] + dr * this.feedback
      this.write = this.write + 1 === size ? 0 : this.write + 1
      left[i] = left[i] * (1 - this.mix) + dl * this.mix
      right[i] = right[i] * (1 - this.mix) + dr * this.mix
    }
  }
}

/** Delay-line lengths of the classic Freeverb design, in samples at 44.1 kHz. */
const COMB_TUNING = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617]
const ALLPASS_TUNING = [556, 441, 341, 225]
/** The right channel's lines are slightly longer, which widens the sound. */
const STEREO_SPREAD = 23
/** Brings the reverb's output up to roughly the level of what went in. */
const WET_GAIN = 1.5

class Comb {
  private buffer: Float32Array
  private index = 0
  private store = 0
  feedback = 0
  damp = 0
  constructor(readonly length: number) {
    this.buffer = new Float32Array(length)
  }
  tick(input: number): number {
    const output = this.buffer[this.index]
    // A low-pass in the loop makes high frequencies die away sooner, as in a real room.
    this.store = output * (1 - this.damp) + this.store * this.damp
    this.buffer[this.index] = input + this.store * this.feedback
    if (++this.index === this.length) this.index = 0
    return output
  }
}

class Allpass {
  private buffer: Float32Array
  private index = 0
  constructor(length: number) {
    this.buffer = new Float32Array(length)
  }
  tick(input: number): number {
    const delayed = this.buffer[this.index]
    this.buffer[this.index] = input + delayed * 0.5
    if (++this.index === this.buffer.length) this.index = 0
    return delayed - input
  }
}

/** Algorithmic reverb: eight parallel damped comb filters into four all-pass filters per channel. */
class Reverb implements EffectDsp {
  private combs: Comb[][]
  private allpasses: Allpass[][]
  private mix = 0.3

  constructor(private rate: number) {
    const scale = rate / 44100
    const length = (tuning: number, channel: number): number => Math.round((tuning + channel * STEREO_SPREAD) * scale)
    this.combs = [0, 1].map((channel) => COMB_TUNING.map((t) => new Comb(length(t, channel))))
    this.allpasses = [0, 1].map((channel) => ALLPASS_TUNING.map((t) => new Allpass(length(t, channel))))
  }

  set(p: Record<string, number>): void {
    this.mix = p.mix
    const damp = Math.exp((-2 * Math.PI * p.tone) / this.rate)
    for (const channel of this.combs) {
      for (const comb of channel) {
        // Feedback that makes this comb die away by 60 dB in `decay` seconds.
        comb.feedback = 10 ** ((-3 * comb.length) / this.rate / p.decay)
        comb.damp = damp
      }
    }
  }

  process(left: Float32Array, right: Float32Array): void {
    const { mix } = this
    for (let i = 0; i < left.length; i++) {
      const input = (left[i] + right[i]) * 0.015
      let wl = 0
      let wr = 0
      for (let c = 0; c < COMB_TUNING.length; c++) {
        wl += this.combs[0][c].tick(input)
        wr += this.combs[1][c].tick(input)
      }
      for (let a = 0; a < ALLPASS_TUNING.length; a++) {
        wl = this.allpasses[0][a].tick(wl)
        wr = this.allpasses[1][a].tick(wr)
      }
      left[i] = left[i] * (1 - mix) + wl * WET_GAIN * mix
      right[i] = right[i] * (1 - mix) + wr * WET_GAIN * mix
    }
  }
}
