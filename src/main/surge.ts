/**
 * Surge XT's patches, for the app to offer in its own instrument picker.
 *
 * Surge keeps each patch as an .fxp file, and what it saves as a plugin's
 * state is that same patch. So a patch can be chosen here and handed to the
 * engine as plugin state, with no need to open Surge's window: the state is
 * made from the file, in the wrapping the engine's plugin host expects.
 */
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { SurgePatch } from '@shared/model'

/** Where Surge XT's installer puts its patches, and where a user's own go (see its "WHERE TO PLACE USER DATA.txt"). */
function patchFolders(): { folder: string; factory: boolean }[] {
  const shared =
    process.platform === 'darwin'
      ? '/Library/Application Support/Surge XT'
      : process.platform === 'win32'
        ? join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'Surge XT')
        : '/usr/share/surge-xt'
  return [
    { folder: join(shared, 'patches_factory'), factory: true },
    { folder: join(shared, 'patches_3rdparty'), factory: false },
    { folder: join(homedir(), 'Documents', 'Surge XT', 'Patches'), factory: false }
  ]
}

let cached: SurgePatch[] | null = null

/**
 * Every patch found, ordered by category and then name. Factory patches are
 * filed as `Category/Name.fxp`; the rest as `Author/Category/Name.fxp`, or
 * however their owner has arranged them.
 */
export async function surgePatches(): Promise<SurgePatch[]> {
  if (cached) return cached
  const found: SurgePatch[] = []
  const walk = async (root: string, factory: boolean, within: string[]): Promise<void> => {
    const entries = await readdir(join(root, ...within), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        if (within.length < 4) await walk(root, factory, [...within, entry.name])
      } else if (entry.name.toLowerCase().endsWith('.fxp')) {
        found.push({
          name: entry.name.slice(0, -4),
          // The folder the file is in is its category; the folder above that, outside the factory set, its author.
          category: within[within.length - 1] ?? 'Other',
          author: factory ? 'Factory' : (within[within.length - 2] ?? within[0] ?? 'User'),
          path: join(root, ...within, entry.name)
        })
      }
    }
  }
  for (const { folder, factory } of patchFolders()) await walk(folder, factory, [])
  cached = found.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name, undefined, { numeric: true }))
  return cached
}

/**
 * The plugin state that loads a patch into Surge XT's VST3, as the base64
 * text a project holds (`Track.pluginState`). Null if the file is not one of
 * the patches listed, or is not a patch.
 */
export async function surgePatchState(path: string): Promise<string | null> {
  // Only files inside Surge's own patch folders are read: the path comes from the page.
  const wanted = resolve(path)
  if (!wanted.toLowerCase().endsWith('.fxp') || !patchFolders().some(({ folder }) => wanted.startsWith(resolve(folder) + sep))) return null
  const file = await readFile(wanted).catch(() => null)
  // An .fxp holding one opaque chunk: "CcnK", a length, "FPCh", and after a 60-byte header the chunk, whose length is the header's last field.
  if (!file || file.length < 64 || file.toString('latin1', 0, 4) !== 'CcnK' || file.toString('latin1', 8, 12) !== 'FPCh') return null
  const patch = file.subarray(60, 60 + file.readUInt32BE(56))
  // Surge's own patches begin "sub3"; anything else is some other plugin's program.
  if (patch.toString('latin1', 0, 4) !== 'sub3') return null
  return vst3HostState(patch).toString('base64')
}

/**
 * A VST3 plugin's state as JUCE's plugin host keeps it (which is what the
 * engine reads and writes): an XML document naming the component's state,
 * in JUCE's binary wrapping for XML ("VC2!", the length, the text, a zero).
 */
function vst3HostState(component: Buffer): Buffer {
  const xml = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?> <VST3PluginState><IComponent>${juceBase64(component)}</IComponent></VST3PluginState>`, 'utf8')
  const head = Buffer.alloc(8)
  head.write('VC2!', 0, 'latin1')
  head.writeUInt32LE(xml.length, 4)
  return Buffer.concat([head, xml, Buffer.alloc(1)])
}

/**
 * JUCE's own text encoding of a block of bytes (`MemoryBlock::toBase64Encoding`),
 * which is not standard base64: the length, a dot, then six bits to a
 * character taken least-significant bit first, in an alphabet of its own.
 */
function juceBase64(data: Buffer): string {
  const alphabet = '.ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+'
  const count = Math.ceil((data.length * 8) / 6)
  const out = new Array<string>(count)
  for (let i = 0; i < count; i++) {
    let value = 0
    for (let bit = 0; bit < 6; bit++) {
      const at = i * 6 + bit
      const byte = at >> 3
      if (byte < data.length && data[byte] & (1 << (at & 7))) value |= 1 << bit
    }
    out[i] = alphabet[value]
  }
  return `${data.length}.${out.join('')}`
}
