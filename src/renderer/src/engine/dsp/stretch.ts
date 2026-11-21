/**
 * Time-stretching by waveform-similarity overlap-add (WSOLA): the sound is
 * cut into short overlapping grains that are laid down closer together or
 * further apart, each one nudged to where it lines up best with the last, so
 * the length changes but the pitch does not.
 *
 * `ratio` is output length over input length. Returns new channel arrays.
 */
export function timeStretch(channels: Float32Array[], ratio: number, rate: number): Float32Array[] {
  // Grains of about 40 ms, half overlapping.
  const size = 2 ** Math.round(Math.log2(rate * 0.04))
  const hop = size / 2
  const search = size / 4
  const inLength = channels[0].length
  const outLength = Math.floor(inLength * ratio)
  if (inLength < size * 2) return channels.map((c) => c.slice())

  // Grain alignment is judged on a mono mix so the channels stay in step.
  let mono = channels[0]
  if (channels.length > 1) {
    mono = new Float32Array(inLength)
    for (const channel of channels) for (let i = 0; i < inLength; i++) mono[i] += channel[i] / channels.length
  }

  // A periodic Hann window: half-overlapped copies sum to exactly 1.
  const window = new Float32Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)

  const out = channels.map(() => new Float32Array(outLength + size))
  const lastStart = inLength - size
  let previous = 0

  for (let outPos = 0; outPos < outLength; outPos += hop) {
    const ideal = Math.min(lastStart, Math.round(outPos / ratio))
    let start = ideal
    // What would have come next had the previous grain simply carried on.
    const natural = previous + hop
    if (outPos > 0 && natural <= lastStart) {
      let best = -Infinity
      for (let shift = -search; shift <= search; shift += 2) {
        const candidate = ideal + shift
        if (candidate < 0 || candidate > lastStart) continue
        let match = 0
        for (let i = 0; i < hop; i += 4) match += mono[candidate + i] * mono[natural + i]
        if (match > best) {
          best = match
          start = candidate
        }
      }
    }
    for (let c = 0; c < channels.length; c++) {
      const source = channels[c]
      const target = out[c]
      for (let i = 0; i < size; i++) target[outPos + i] += source[start + i] * window[i]
    }
    previous = start
  }
  return out.map((channel) => channel.subarray(0, outLength))
}
