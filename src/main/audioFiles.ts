/**
 * Disk-side support for playing long audio files without loading them whole:
 * finding out whether a file can be streamed, reading pieces of it, and
 * caching its waveform overview.
 *
 * A file can be streamed if it is an uncompressed WAV. Anything else (MP3,
 * FLAC …) is "conformed" once: the renderer decodes it and hands the samples
 * back to be written as a WAV in the cache, which is streamed from then on.
 */
import { app } from 'electron'
import { createHash } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConformStep } from '@shared/bridge'
import { decodePcm, type PcmFormat, type StreamInfo } from '@shared/pcm'

const PEAKS_PER_SECOND = 200

interface Streamable {
  /** The WAV to read from: the file itself, or its conformed copy. */
  file: string
  info: StreamInfo
  dataOffset: number
  /** Identifies the source file's content; names its cache entries. */
  key: string
}

// Not plain 'cache': on a case-insensitive disk that is Chromium's own Cache folder.
const cacheDir = (): string => join(app.getPath('userData'), 'audio-cache')
const known = new Map<string, Streamable>()

/** A key from the file's size and first 64 KB, so a copy of the file shares its cache entries. */
async function contentKey(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const head = Buffer.alloc(Math.min(size, 65536))
    await handle.read(head, 0, head.length, 0)
    return createHash('sha1').update(head).update(String(size)).digest('hex')
  } finally {
    await handle.close()
  }
}

/** Reads a WAV file's header. Null if it is not an uncompressed WAV. */
async function readWavHeader(path: string): Promise<{ info: StreamInfo; dataOffset: number } | null> {
  const handle = await open(path, 'r')
  try {
    const { size } = await handle.stat()
    const riff = Buffer.alloc(12)
    await handle.read(riff, 0, 12, 0)
    if (riff.toString('latin1', 0, 4) !== 'RIFF' || riff.toString('latin1', 8, 12) !== 'WAVE') return null

    let format: PcmFormat | null = null
    let channels = 0
    let sampleRate = 0
    let blockAlign = 0
    const head = Buffer.alloc(8)
    // Walk the chunks: 'fmt ' describes the audio, 'data' holds it.
    for (let position = 12; position + 8 <= size; ) {
      await handle.read(head, 0, 8, position)
      const id = head.toString('latin1', 0, 4)
      const length = head.readUInt32LE(4)
      if (id === 'fmt ') {
        const fmt = Buffer.alloc(Math.min(length, 40))
        await handle.read(fmt, 0, fmt.length, position + 8)
        let tag = fmt.readUInt16LE(0)
        channels = fmt.readUInt16LE(2)
        sampleRate = fmt.readUInt32LE(4)
        blockAlign = fmt.readUInt16LE(12)
        const bits = fmt.readUInt16LE(14)
        // "Extensible" WAVs keep the real format code a little further on.
        if (tag === 0xfffe && fmt.length >= 26) tag = fmt.readUInt16LE(24)
        if (tag === 1 && bits === 16) format = 'int16'
        else if (tag === 1 && bits === 24) format = 'int24'
        else if (tag === 1 && bits === 32) format = 'int32'
        else if (tag === 3 && bits === 32) format = 'float32'
      } else if (id === 'data') {
        if (!format || !channels || !sampleRate || !blockAlign) return null
        const bytes = Math.min(length, size - position - 8)
        return { info: { sampleRate, channels, format, blockAlign, frames: Math.floor(bytes / blockAlign) }, dataOffset: position + 8 }
      }
      position += 8 + length + (length % 2)
    }
    return null
  } finally {
    await handle.close()
  }
}

/** How to stream a file, if it can be: directly, or through a conformed copy made earlier. */
async function streamable(path: string): Promise<Streamable | null> {
  const cached = known.get(path)
  if (cached) return cached
  const key = await contentKey(path)
  const conformed = join(cacheDir(), `${key}.wav`)
  for (const file of [path, conformed]) {
    const header = await readWavHeader(file).catch(() => null)
    if (header) {
      const entry = { file, key, ...header }
      known.set(path, entry)
      return entry
    }
  }
  return null
}

/** The WAV a streamable file is read from: the file itself or its conformed copy. Null if it cannot be streamed. */
export async function streamFile(path: string): Promise<string | null> {
  return (await streamable(path))?.file ?? null
}

export async function probe(path: string): Promise<{ stream: StreamInfo | null; bytes: number }> {
  const [{ size }, entry] = await Promise.all([stat(path), streamable(path)])
  return { stream: entry?.info ?? null, bytes: size }
}

/** Raw PCM bytes for `count` frames starting at `frame`. */
export async function readRange(path: string, frame: number, count: number): Promise<ArrayBuffer> {
  const entry = await streamable(path)
  if (!entry) return new ArrayBuffer(0)
  const { info, dataOffset, file } = entry
  const first = Math.max(0, Math.min(info.frames, Math.floor(frame)))
  const frames = Math.max(0, Math.min(info.frames - first, Math.floor(count)))
  const buffer = Buffer.alloc(frames * info.blockAlign)
  const handle = await open(file, 'r')
  try {
    await handle.read(buffer, 0, buffer.length, dataOffset + first * info.blockAlign)
  } finally {
    await handle.close()
  }
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}

/**
 * The file's waveform overview: interleaved min/max pairs as Float32 bytes.
 * Worked out by reading the file through once, then kept in the cache.
 */
export async function peaks(path: string): Promise<{ peaks: ArrayBuffer; secondsPerPeak: number; duration: number } | null> {
  const entry = await streamable(path)
  if (!entry) return null
  const { info, dataOffset, file, key } = entry
  const bucket = Math.max(1, Math.round(info.sampleRate / PEAKS_PER_SECOND))
  const result = (data: Buffer): { peaks: ArrayBuffer; secondsPerPeak: number; duration: number } => ({
    peaks: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer,
    secondsPerPeak: bucket / info.sampleRate,
    duration: info.frames / info.sampleRate
  })

  const cacheFile = join(cacheDir(), `${key}.peaks`)
  const count = Math.ceil(info.frames / bucket)
  const cached = await readFile(cacheFile).catch(() => null)
  if (cached && cached.byteLength === count * 8) return result(cached)

  const out = new Float32Array(count * 2)
  const bucketsPerRead = 2000
  const block = Buffer.alloc(bucket * bucketsPerRead * info.blockAlign)
  const handle = await open(file, 'r')
  try {
    for (let index = 0; index < count; index += bucketsPerRead) {
      const { bytesRead } = await handle.read(block, 0, block.length, dataOffset + index * bucket * info.blockAlign)
      const channels = decodePcm(block.subarray(0, bytesRead), info)
      const frames = channels[0].length
      for (let b = 0; b * bucket < frames; b++) {
        let min = 0
        let max = 0
        const end = Math.min(frames, (b + 1) * bucket)
        for (let i = b * bucket; i < end; i++) {
          let value = 0
          for (const channel of channels) value += channel[i]
          value /= channels.length
          if (value < min) min = value
          if (value > max) max = value
        }
        out[(index + b) * 2] = min
        out[(index + b) * 2 + 1] = max
      }
    }
  } finally {
    await handle.close()
  }
  const data = Buffer.from(out.buffer)
  await mkdir(cacheDir(), { recursive: true })
  await writeFile(cacheFile, data).catch(() => {})
  return result(data)
}

// ── Conforming ───────────────────────────────────────────────────────────

const conforming = new Map<string, { handle: FileHandle; temp: string; final: string }>()

/** Writes a decoded copy of a compressed file into the cache as a float WAV, a piece at a time. */
export async function conform(path: string, step: ConformStep): Promise<void> {
  if (step.type === 'begin') {
    const key = await contentKey(path)
    await mkdir(cacheDir(), { recursive: true })
    const final = join(cacheDir(), `${key}.wav`)
    const temp = `${final}.part`
    const handle = await open(temp, 'w')
    const blockAlign = step.channels * 4
    const dataBytes = step.frames * blockAlign
    const header = Buffer.alloc(44)
    header.write('RIFF', 0, 'latin1')
    header.writeUInt32LE(Math.min(0xffffffff, 36 + dataBytes), 4)
    header.write('WAVEfmt ', 8, 'latin1')
    header.writeUInt32LE(16, 16)
    header.writeUInt16LE(3, 20)
    header.writeUInt16LE(step.channels, 22)
    header.writeUInt32LE(step.sampleRate, 24)
    header.writeUInt32LE(step.sampleRate * blockAlign, 28)
    header.writeUInt16LE(blockAlign, 32)
    header.writeUInt16LE(32, 34)
    header.write('data', 36, 'latin1')
    header.writeUInt32LE(Math.min(0xffffffff, dataBytes), 40)
    await handle.write(header)
    conforming.set(path, { handle, temp, final })
    return
  }
  const job = conforming.get(path)
  if (!job) return
  if (step.type === 'data') {
    await job.handle.write(Buffer.from(step.data))
    return
  }
  await job.handle.close()
  conforming.delete(path)
  // Only a finished file gets the real name, so a crash mid-way leaves nothing half-written in use.
  await rename(job.temp, job.final).catch(() => rm(job.temp, { force: true }))
  known.delete(path)
}
