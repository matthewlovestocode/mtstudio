export type BiquadType = 'lowpass' | 'highpass' | 'bandpass' | 'lowshelf' | 'highshelf' | 'peaking'

/** A second-order filter (Audio EQ Cookbook formulas), transposed direct form II. */
export class Biquad {
  private b0 = 1
  private b1 = 0
  private b2 = 0
  private a1 = 0
  private a2 = 0
  private z1 = 0
  private z2 = 0

  /** `q` is linear; `gainDb` only matters for shelves and the peaking type. */
  set(type: BiquadType, frequency: number, q: number, gainDb: number, rate: number): void {
    const w0 = (2 * Math.PI * Math.min(Math.max(frequency, 10), rate * 0.49)) / rate
    const cos = Math.cos(w0)
    const sin = Math.sin(w0)
    const A = 10 ** (gainDb / 40)
    let alpha = sin / (2 * Math.max(q, 0.01))
    let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number

    switch (type) {
      case 'lowpass':
        b0 = (1 - cos) / 2
        b1 = 1 - cos
        b2 = b0
        a0 = 1 + alpha
        a1 = -2 * cos
        a2 = 1 - alpha
        break
      case 'highpass':
        b0 = (1 + cos) / 2
        b1 = -(1 + cos)
        b2 = b0
        a0 = 1 + alpha
        a1 = -2 * cos
        a2 = 1 - alpha
        break
      case 'bandpass':
        b0 = alpha
        b1 = 0
        b2 = -alpha
        a0 = 1 + alpha
        a1 = -2 * cos
        a2 = 1 - alpha
        break
      case 'peaking':
        b0 = 1 + alpha * A
        b1 = -2 * cos
        b2 = 1 - alpha * A
        a0 = 1 + alpha / A
        a1 = -2 * cos
        a2 = 1 - alpha / A
        break
      default: {
        // Shelves, with a slope of 1.
        alpha = (sin / 2) * Math.SQRT2
        const k = 2 * Math.sqrt(A) * alpha
        if (type === 'lowshelf') {
          b0 = A * (A + 1 - (A - 1) * cos + k)
          b1 = 2 * A * (A - 1 - (A + 1) * cos)
          b2 = A * (A + 1 - (A - 1) * cos - k)
          a0 = A + 1 + (A - 1) * cos + k
          a1 = -2 * (A - 1 + (A + 1) * cos)
          a2 = A + 1 + (A - 1) * cos - k
        } else {
          b0 = A * (A + 1 + (A - 1) * cos + k)
          b1 = -2 * A * (A - 1 + (A + 1) * cos)
          b2 = A * (A + 1 + (A - 1) * cos - k)
          a0 = A + 1 - (A - 1) * cos + k
          a1 = 2 * (A - 1 - (A + 1) * cos)
          a2 = A + 1 - (A - 1) * cos - k
        }
      }
    }
    this.b0 = b0 / a0
    this.b1 = b1 / a0
    this.b2 = b2 / a0
    this.a1 = a1 / a0
    this.a2 = a2 / a0
  }

  tick(x: number): number {
    const y = this.b0 * x + this.z1
    this.z1 = this.b1 * x - this.a1 * y + this.z2
    this.z2 = this.b2 * x - this.a2 * y
    return y
  }
}
