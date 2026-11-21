/** Encodes planar audio as a WAV file: 32-bit float or 24-bit PCM. */
export function encodeWav(channels: Float32Array[], sampleRate: number, format: 'float32' | 'pcm24'): ArrayBuffer {
  const frames = channels[0]?.length ?? 0
  const bytesPerSample = format === 'float32' ? 4 : 3
  const blockAlign = channels.length * bytesPerSample
  const dataSize = frames * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }

  text(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  text(8, 'WAVEfmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, format === 'float32' ? 3 : 1, true)
  view.setUint16(22, channels.length, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bytesPerSample * 8, true)
  text(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let frame = 0; frame < frames; frame++) {
    for (const channel of channels) {
      const sample = channel[frame]
      if (format === 'float32') {
        view.setFloat32(offset, sample, true)
      } else {
        const value = Math.round(Math.max(-1, Math.min(1, sample)) * 0x7fffff)
        view.setUint8(offset, value & 0xff)
        view.setUint8(offset + 1, (value >> 8) & 0xff)
        view.setUint8(offset + 2, (value >> 16) & 0xff)
      }
      offset += bytesPerSample
    }
  }
  return buffer
}
