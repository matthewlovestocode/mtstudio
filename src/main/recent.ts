/**
 * The projects the user has opened or saved through the app's own dialogs,
 * newest first. An assistant may open these and no others (see mcp.ts), so
 * this list is what stands between it and the rest of the disk.
 */
import { app } from 'electron'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const LIMIT = 30
const listPath = (): string => join(app.getPath('userData'), 'recent.json')
let recent: string[] | null = null

async function load(): Promise<string[]> {
  if (recent) return recent
  const read = await readFile(listPath(), 'utf8').catch(() => null)
  try {
    const stored: unknown = read ? JSON.parse(read) : []
    recent = Array.isArray(stored) ? stored.filter((each): each is string => typeof each === 'string') : []
  } catch {
    recent = []
  }
  return recent
}

/** Notes that the user chose this project file. */
export async function rememberProject(path: string): Promise<void> {
  const list = await load()
  recent = [path, ...list.filter((each) => each !== path)].slice(0, LIMIT)
  await writeFile(listPath(), JSON.stringify(recent, null, 2), 'utf8').catch(() => {})
}

export async function isRecentProject(path: string): Promise<boolean> {
  return (await load()).includes(path)
}

/** Those of the list that are still there. */
export async function recentProjects(): Promise<string[]> {
  const list = await load()
  const there = await Promise.all(list.map((path) => stat(path).then((s) => s.isFile(), () => false)))
  return list.filter((_, index) => there[index])
}
