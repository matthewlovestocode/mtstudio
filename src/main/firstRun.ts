/**
 * The packaged app does not carry its sound content: the first time it is
 * started it downloads the files the manifest lists (the General MIDI
 * SoundFont) into the content folder, in a small window that shows how far it
 * has got. Run from source, `npm run fetch:content` does the same job.
 */
import { BrowserWindow, dialog } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { APP_NAME } from '@shared/menu'
import { bundledContent, contentFolder } from './sfz'

interface ManifestFile {
  name: string
  file: string
  url: string
  bytes: number
  sha256: string
  license: string
  licenseFile?: string
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

const PAGE = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:22px 24px;background:#15171c;color:#e6e8ee;font:13px -apple-system,system-ui,sans-serif;user-select:none}
h1{font-size:14px;font-weight:600;margin:0 0 6px}p{margin:0 0 14px;color:#9aa1b0;line-height:1.4}
.bar{height:6px;border-radius:3px;background:#2a2e38;overflow:hidden}.bar i{display:block;height:100%;width:0;background:#6ea8ff}
small{display:block;margin-top:8px;color:#9aa1b0}</style>
<h1>Getting the instrument sounds</h1><p id="what"></p><div class="bar"><i id="fill"></i></div><small id="how"></small>
<script>function show(what,part,how){document.getElementById('what').textContent=what;document.getElementById('fill').style.width=(part*100)+'%';document.getElementById('how').textContent=how}</script>`

/**
 * Downloads whatever listed content is missing. Closing the window stops it;
 * what is missing is then tried for again the next time the app starts.
 */
export async function fetchMissingContent(): Promise<void> {
  const read = await readFile(join(bundledContent(), 'manifest.json'), 'utf8').catch(() => null)
  if (!read) return
  // A file's name becomes part of a path, so only plain ones are taken.
  const files = ((JSON.parse(read) as { files?: ManifestFile[] }).files ?? []).filter((file) => /^[\w .-]+$/.test(file.file) && !file.file.startsWith('.') && file.url.startsWith('https://'))
  const missing: ManifestFile[] = []
  for (const file of files) if (!(await stat(join(contentFolder(), file.file)).then((s) => s.isFile(), () => false))) missing.push(file)
  if (missing.length === 0) return

  const stop = new AbortController()
  const window = new BrowserWindow({
    width: 440,
    height: 170,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: '#15171c',
    title: APP_NAME,
    webPreferences: { contextIsolation: true, nodeIntegration: false }
  })
  window.setMenuBarVisibility(false)
  window.on('closed', () => stop.abort())
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
  const show = (what: string, part: number, how: string): void => {
    if (!window.isDestroyed()) void window.webContents.executeJavaScript(`show(${JSON.stringify(what)},${part},${JSON.stringify(how)})`).catch(() => {})
  }

  let failure: string | null = null
  try {
    await mkdir(contentFolder(), { recursive: true })
    for (const file of missing) {
      const path = join(contentFolder(), file.file)
      const part = `${path}.part`
      const total = (file.bytes / 1e6).toFixed(0)
      const what = `${file.name} (${file.license}), from ${new URL(file.url).host}. This happens once. Close this window to skip it for now.`
      show(what, 0, `0 of ${total} MB`)
      const response = await fetch(file.url, { signal: stop.signal })
      if (!response.ok || !response.body) {
        failure = `${file.name} could not be downloaded (${response.status}).`
        break
      }
      // Written beside its final place and moved in when whole and checked, so a broken download is never mistaken for the file.
      const out = createWriteStream(part)
      let received = 0
      let reported = 0
      for await (const chunk of response.body) {
        if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve))
        received += chunk.byteLength
        if (received - reported > 1e6) show(what, Math.min(1, (reported = received) / file.bytes), `${(received / 1e6).toFixed(0)} of ${total} MB`)
      }
      await new Promise<void>((resolve, reject) => out.end((error?: Error | null) => (error ? reject(error) : resolve())))
      show(what, 1, 'Checking the download')
      if ((await sha256(part)) !== file.sha256) {
        await rm(part, { force: true })
        failure = `${file.name} did not arrive whole (its checksum does not match).`
        break
      }
      await rename(part, path)
      // A file's licence goes wherever the file goes.
      if (file.licenseFile && /^[\w ./-]+$/.test(file.licenseFile) && !file.licenseFile.includes('..')) {
        const licence = join(contentFolder(), file.licenseFile)
        await mkdir(dirname(licence), { recursive: true })
        await copyFile(join(bundledContent(), file.licenseFile), licence).catch(() => {})
      }
    }
  } catch (error) {
    for (const file of missing) await rm(join(contentFolder(), `${file.file}.part`), { force: true }).catch(() => {})
    if (!stop.signal.aborted) failure = error instanceof Error ? `The instrument sounds could not be downloaded: ${error.message}` : 'The instrument sounds could not be downloaded.'
  }
  if (failure) {
    await dialog.showMessageBox({
      type: 'warning',
      message: 'The instrument sounds were not downloaded',
      detail: `${failure}\n\n${APP_NAME} will open without them, so SoundFont instruments and drum kits will be missing, and it will try again the next time it starts.`
    })
  }
  if (!window.isDestroyed()) {
    window.removeAllListeners('closed')
    // Closed a moment later, once the main window exists: on Windows and Linux the app quits when its last window closes.
    setTimeout(() => !window.isDestroyed() && window.destroy(), 1500)
  }
}
