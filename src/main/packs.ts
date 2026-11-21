/**
 * The library of sound content that can be installed from within the app:
 * the SFZ packs listed in the content folder's manifest. Each is a
 * repository at one pinned commit, fetched as an archive and unpacked into
 * `sfz/` in the content folder, where the list of instruments finds it.
 */
import { dialog, type BrowserWindow } from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentPack } from '@shared/bridge'
import { bundledContent, contentFolder } from './sfz'

interface ManifestPack {
  id: string
  name: string
  kind?: string
  folder: string
  /** `owner/name` on GitHub. */
  repository: string
  commit: string
  megabytes: number
  license: string
  credit: string
  description: string
}

/** The manifest is the repository's own (or the packaged app's): what may be installed is not something the content folder can say for itself. */
async function manifest(): Promise<ManifestPack[]> {
  const path = join(bundledContent(), 'manifest.json')
  const read = await readFile(path, 'utf8').catch(() => null)
  if (!read) return []
  // A pack's folder and repository become part of a path and an address, so only plain ones are taken.
  const packs = ((JSON.parse(read) as { packs?: ManifestPack[] }).packs ?? []).filter(
    (pack) => /^[\w .-]+$/.test(pack.folder) && !pack.folder.startsWith('.') && /^[\w.-]+\/[\w.-]+$/.test(pack.repository) && /^[0-9a-f]{40}$/.test(pack.commit)
  )
  return packs
}

const installing = new Set<string>()

export async function contentPacks(): Promise<ContentPack[]> {
  const packs = await manifest()
  return Promise.all(
    packs.map(async (pack) => ({
      id: pack.id,
      name: pack.name,
      kind: pack.kind ?? 'Other',
      description: pack.description,
      megabytes: pack.megabytes,
      license: pack.license,
      credit: pack.credit,
      source: `github.com/${pack.repository}`,
      installed: await stat(join(contentFolder(), 'sfz', pack.folder)).then((s) => s.isDirectory(), () => false),
      installing: installing.has(pack.id)
    }))
  )
}

/**
 * Downloads and unpacks a pack, telling the window how far it has got.
 * Returns null when it is installed, or a sentence saying why it is not.
 */
export async function installPack(id: string, getWindow: () => BrowserWindow | null): Promise<string | null> {
  const pack = (await manifest()).find((each) => each.id === id)
  if (!pack) return 'That pack is not in the library.'
  if (installing.has(id)) return 'That pack is already being installed.'
  const sfz = join(contentFolder(), 'sfz')
  const target = join(sfz, pack.folder)
  // Downloaded and unpacked beside its final place, then moved in whole: a half-installed pack is never listed.
  const work = join(sfz, `.installing-${pack.id}`)
  const archive = join(work, 'pack.tar.gz')
  const unpacked = join(work, 'unpacked')
  const report = (received: number, stage: 'downloading' | 'unpacking'): void =>
    getWindow()?.webContents.send('content:progress', { id, stage, megabytes: received / 1e6 })

  installing.add(id)
  try {
    await rm(work, { recursive: true, force: true })
    await mkdir(unpacked, { recursive: true })
    const response = await fetch(`https://codeload.github.com/${pack.repository}/tar.gz/${pack.commit}`)
    if (!response.ok || !response.body) return `The download failed (${response.status}).`
    const out = createWriteStream(archive)
    let received = 0
    let reported = 0
    for await (const chunk of response.body) {
      // Wait where the disk is slower than the network, so the download is not held in memory.
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve))
      received += chunk.byteLength
      if (received - reported > 2e6) report((reported = received), 'downloading')
    }
    await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())))
    report(received, 'unpacking')
    // The archive holds one folder named for the repository and commit; its contents are what is wanted.
    const code = await new Promise<number>((resolve) => {
      const tar = spawn('tar', ['-xzf', archive, '-C', unpacked, '--strip-components', '1'], { stdio: 'ignore' })
      tar.on('error', () => resolve(-1))
      tar.on('exit', (status) => resolve(status ?? -1))
    })
    if (code !== 0) return 'The pack was downloaded but could not be unpacked.'
    await rm(target, { recursive: true, force: true })
    await rename(unpacked, target)
    return null
  } catch (error) {
    return error instanceof Error ? `The pack could not be installed: ${error.message}` : 'The pack could not be installed.'
  } finally {
    installing.delete(id)
    await rm(work, { recursive: true, force: true }).catch(() => {})
  }
}

/** Deletes an installed pack's files, after asking. Returns whether it was removed. */
export async function removePack(id: string, getWindow: () => BrowserWindow | null): Promise<boolean> {
  const pack = (await manifest()).find((each) => each.id === id)
  const window = getWindow()
  if (!pack || !window) return false
  const { response } = await dialog.showMessageBox(window, {
    type: 'warning',
    buttons: ['Cancel', 'Remove'],
    defaultId: 0,
    cancelId: 0,
    message: `Remove ${pack.name}?`,
    detail: `Its ${pack.megabytes} MB of samples will be deleted from this computer. Tracks that use it will be silent until it is installed again.`
  })
  if (response !== 1) return false
  await rm(join(contentFolder(), 'sfz', pack.folder), { recursive: true, force: true })
  return true
}
