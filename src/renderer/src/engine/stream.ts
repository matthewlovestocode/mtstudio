import type { AudioStream } from './types'

/** Seconds of audio in each piece read from disk. */
const CHUNK = 2
/** Neighbouring pieces overlap by this much and are cross-faded, so the joins are inaudible. */
const OVERLAP = 0.01
/** Keep this much audio scheduled ahead of the audio clock. */
const AHEAD = 3
/** A piece that arrives late is started this far in the future, skipping what was missed. */
const LATE_MARGIN = 0.005

/**
 * Plays part of a file straight from disk: pieces are read a few seconds
 * ahead and scheduled back to back, so memory use does not grow with the
 * length of the file.
 */
export class StreamPlayer {
  private nodes = new Set<AudioBufferSourceNode>()
  /** Index of the next piece to read. */
  private next = 0
  private reading = false
  private stopped = false

  /**
   * @param when      audio-clock time at which playback begins
   * @param position  seconds into the file to begin at
   * @param duration  seconds to play
   */
  constructor(
    private ctx: BaseAudioContext,
    private stream: AudioStream,
    private output: AudioNode,
    private when: number,
    private position: number,
    private duration: number
  ) {
    this.pump()
  }

  /** Reads and schedules the next piece if it will be needed soon. Call regularly while playing. */
  pump(): void {
    const start = this.next * CHUNK
    if (this.stopped || this.reading || start >= this.duration) return
    if (this.when + start > this.ctx.currentTime + AHEAD) return
    this.reading = true
    const index = this.next++
    const { sampleRate } = this.stream
    const last = start + CHUNK >= this.duration
    // Every piece but the last runs on into the next one's first few milliseconds.
    const seconds = Math.min(this.duration - start, CHUNK + (last ? 0 : OVERLAP))
    const frame = Math.round((this.position + start) * sampleRate)
    void this.stream.read(frame, Math.ceil(seconds * sampleRate)).then(
      (channels) => {
        this.reading = false
        if (!this.stopped && channels[0]?.length) this.schedule(channels, index, seconds, last)
        this.pump()
      },
      () => {
        // A failed read leaves a gap; later pieces can still play.
        this.reading = false
      }
    )
  }

  private schedule(channels: Float32Array[], index: number, seconds: number, last: boolean): void {
    const { ctx } = this
    const buffer = ctx.createBuffer(channels.length, channels[0].length, this.stream.sampleRate)
    channels.forEach((channel, c) => buffer.copyToChannel(channel as Float32Array<ArrayBuffer>, c))
    const source = ctx.createBufferSource()
    source.buffer = buffer
    const fade = ctx.createGain()
    source.connect(fade)
    fade.connect(this.output)

    const begin = this.when + index * CHUNK
    const end = begin + seconds
    // If the disk was slow, start now and skip what should already have played.
    const earliest = ctx.currentTime + LATE_MARGIN
    const late = Math.max(0, earliest - begin)
    if (late >= seconds) return

    if (index > 0 && late === 0) {
      fade.gain.setValueAtTime(0, begin)
      fade.gain.linearRampToValueAtTime(1, begin + OVERLAP)
    }
    if (!last) {
      fade.gain.setValueAtTime(1, end - OVERLAP)
      fade.gain.linearRampToValueAtTime(0, end)
    }
    source.start(begin + late, late, seconds - late)
    this.nodes.add(source)
    source.onended = () => {
      fade.disconnect()
      this.nodes.delete(source)
    }
  }

  /** Stops at `time` on the audio clock, or at once. */
  stop(time?: number): void {
    this.stopped = true
    for (const node of this.nodes) node.stop(time)
  }
}
