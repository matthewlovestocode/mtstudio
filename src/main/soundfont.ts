/**
 * The SoundFont the native engine plays General MIDI instruments from: where
 * it is, and what presets it holds. The list is read here, from the file's
 * index, so the app can offer the presets without the engine having to load
 * two hundred megabytes of samples first.
 */
import { app } from 'electron'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import type { SoundFontPreset } from '@shared/model'

/** `STUDIO_SOUNDFONT`, or the file `npm run fetch:content` downloads (in a packaged app, the copy in its resources). */
export function soundFontPath(): string {
  if (process.env.STUDIO_SOUNDFONT) return process.env.STUDIO_SOUNDFONT
  const name = 'MuseScore_General.sf2'
  return app.isPackaged ? join(process.resourcesPath, 'content', name) : join(app.getAppPath(), 'native', 'content', name)
}

let cached: { path: string; presets: SoundFontPreset[] | null } | null = null

/** The SoundFont's presets, ordered by bank and then program; null if the file is missing or is not a SoundFont. */
export async function soundFontPresets(): Promise<SoundFontPreset[] | null> {
  const path = soundFontPath()
  if (cached?.path !== path) cached = { path, presets: await readPresets(path).catch(() => null) }
  return cached.presets
}

/**
 * A SoundFont is a RIFF file: chunks of a four-letter name, a length and that
 * many bytes, some of them lists of further chunks. The presets are the
 * `phdr` chunk of the `pdta` list, which comes after the samples, so the file
 * is stepped through by its lengths and only that chunk is read.
 */
async function readPresets(path: string): Promise<SoundFontPreset[] | null> {
  const file = await open(path, 'r')
  try {
    const read = async (position: number, length: number): Promise<Buffer> => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await file.read(buffer, 0, length, position)
      return buffer.subarray(0, bytesRead)
    }
    const find = async (from: number, to: number, wanted: string, list: boolean): Promise<{ start: number; end: number } | null> => {
      for (let at = from; at + 8 <= to; ) {
        const head = await read(at, 12)
        if (head.length < 8) return null
        const size = head.readUInt32LE(4)
        const isList = head.toString('latin1', 0, 4) === 'LIST'
        if (list && isList && head.toString('latin1', 8, 12) === wanted) return { start: at + 12, end: at + 8 + size }
        if (!list && head.toString('latin1', 0, 4) === wanted) return { start: at + 8, end: at + 8 + size }
        // Chunks start on even bytes.
        at += 8 + size + (size & 1)
      }
      return null
    }

    const head = await read(0, 12)
    if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'sfbk') return null
    const pdta = await find(12, 8 + head.readUInt32LE(4), 'pdta', true)
    const phdr = pdta && (await find(pdta.start, pdta.end, 'phdr', false))
    if (!phdr) return null

    // Each record is 38 bytes: a 20-byte name, the program number, the bank, and where its zones are. The last is an end marker.
    const records = await read(phdr.start, phdr.end - phdr.start)
    const presets: SoundFontPreset[] = []
    for (let at = 0; at + 76 <= records.length; at += 38) {
      const name = records.toString('latin1', at, at + 20).split('\0')[0].trim()
      presets.push({ bank: records.readUInt16LE(at + 22), program: records.readUInt16LE(at + 20), name: name || 'Unnamed' })
    }
    return presets.sort((a, b) => a.bank - b.bank || a.program - b.program)
  } finally {
    await file.close()
  }
}
