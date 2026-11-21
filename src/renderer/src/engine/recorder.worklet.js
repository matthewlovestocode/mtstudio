/* global AudioWorkletProcessor, registerProcessor, currentTime */

/**
 * Captures its input and posts it to the main thread in batches.
 * Messages in: 'start' | 'stop'.
 * Messages out: { type: 'chunk', time, channels } and { type: 'done' }.
 * `time` is the audio-clock time of the first frame in the chunk.
 */
const BATCH = 4096

class Recorder extends AudioWorkletProcessor {
  constructor() {
    super()
    this.active = false
    this.buffers = []
    this.filled = 0
    this.time = 0
    this.port.onmessage = (event) => {
      if (event.data === 'start') {
        this.active = true
        this.filled = 0
      } else if (event.data === 'stop') {
        this.active = false
        this.flush()
        this.port.postMessage({ type: 'done' })
      }
    }
  }

  flush() {
    if (!this.filled) return
    const channels = this.buffers.map((buffer) => buffer.slice(0, this.filled))
    this.port.postMessage({ type: 'chunk', time: this.time, channels }, channels.map((c) => c.buffer))
    this.filled = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!this.active || !input.length) return true
    if (this.buffers.length !== input.length) {
      this.flush()
      this.buffers = input.map(() => new Float32Array(BATCH))
    }
    if (this.filled === 0) this.time = currentTime
    for (let c = 0; c < input.length; c++) this.buffers[c].set(input[c], this.filled)
    this.filled += input[0].length
    if (this.filled + 128 > BATCH) this.flush()
    return true
  }
}

registerProcessor('recorder', Recorder)
