/**
 * The SFZ instruments installed in the content folder, for the app to offer.
 * Each is an .sfz file somewhere under `sfz/`; the folder directly under
 * `sfz/` is the pack it came in.
 */
import { app } from 'electron'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SfzInstrument } from '@shared/model'

/** Where sound content is: `STUDIO_CONTENT`, or the folder `npm run fetch:content` fills (in a packaged app, the copy in its resources). */
export function contentFolder(): string {
  if (process.env.STUDIO_CONTENT) return process.env.STUDIO_CONTENT
  return app.isPackaged ? join(process.resourcesPath, 'content') : join(app.getAppPath(), 'native', 'content')
}

/** Packs nest their .sfz files a few folders down at most; this stops a stray deep tree from being walked. */
const MAX_DEPTH = 5

export async function sfzInstruments(): Promise<SfzInstrument[]> {
  const found: SfzInstrument[] = []
  const walk = async (within: string[]): Promise<void> => {
    const entries = await readdir(join(contentFolder(), ...within), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (within.length < MAX_DEPTH) await walk([...within, entry.name])
      } else if (entry.name.toLowerCase().endsWith('.sfz') && within.length > 1) {
        // Always with forward slashes: this is what a project records, and it must mean the same on every system.
        found.push({ file: [...within, entry.name].join('/'), name: entry.name.slice(0, -4), pack: within[1] })
      }
    }
  }
  await walk(['sfz'])
  return found.sort((a, b) => a.pack.localeCompare(b.pack) || a.name.localeCompare(b.name, undefined, { numeric: true }))
}
