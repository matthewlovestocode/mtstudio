/** Uncompressed audio as stored in a WAV file, and how to read it. Used by both processes. */

export type PcmFormat = 'int16' | 'int24' | 'int32' | 'float32'

/** Describes a file that can be played straight from disk, a piece at a time. */
export interface StreamInfo {
  sampleRate: number
  channels: number
  /** Length in sample frames. */
  frames: number
  format: PcmFormat
  /** Bytes per frame (all channels). */
  blockAlign: number
}

/** Splits interleaved PCM bytes into one Float32Array per channel. */
export function decodePcm(bytes: Uint8Array, info: Pick<StreamInfo, 'channels' | 'format' | 'blockAlign'>): Float32Array[] {
  const { channels, format, blockAlign } = info
  const frames = Math.floor(bytes.byteLength / blockAlign)
  const out = Array.from({ length: channels }, () => new Float32Array(frames))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = blockAlign / channels
  for (let frame = 0; frame < frames; frame++) {
    for (let c = 0; c < channels; c++) {
      const at = frame * blockAlign + c * width
      let value: number
      switch (format) {
        case 'int16':
          value = view.getInt16(at, true) / 0x8000
          break
        case 'int24':
          value = ((view.getInt8(at + 2) << 16) | (view.getUint8(at + 1) << 8) | view.getUint8(at)) / 0x800000
          break
        case 'int32':
          value = view.getInt32(at, true) / 0x80000000
          break
        default:
          value = view.getFloat32(at, true)
      }
      out[c][frame] = value
    }
  }
  return out
}
