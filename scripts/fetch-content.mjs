// Downloads the sound content listed in native/content/manifest.json that is
// not already there, and checks every file against the SHA-256 recorded for
// it. A file that does not match is removed rather than left to be played.
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const folder = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'content')
const manifest = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'))

async function sha256(path) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

let failed = false
for (const entry of manifest.files) {
  const path = join(folder, entry.file)
  const present = await stat(path).then(() => true, () => false)
  if (!present) {
    console.log(`${entry.name}: downloading ${(entry.bytes / 1e6).toFixed(0)} MB (${entry.license}) from ${new URL(entry.url).host}`)
    const response = await fetch(entry.url)
    if (!response.ok || !response.body) {
      console.error(`${entry.name}: the download failed (${response.status})`)
      failed = true
      continue
    }
    // Written beside its final place and moved in when whole, so a broken download is never mistaken for the file.
    await pipeline(Readable.fromWeb(response.body), createWriteStream(`${path}.part`))
    await rename(`${path}.part`, path)
  }
  if ((await sha256(path)) === entry.sha256) console.log(`${entry.name}: ${present ? 'already here' : 'downloaded'}, checksum matches`)
  else {
    console.error(`${entry.name}: ${entry.file} does not match its checksum and has been removed`)
    await rm(path)
    failed = true
  }
}
process.exit(failed ? 1 : 0)
