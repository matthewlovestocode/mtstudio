import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type MenuItemConstructorOptions } from 'electron'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { AUDIO_EXTENSIONS, type ConformStep, type MenuCommand, type OpenedProject, type SaveRequest, type SaveResult } from '@shared/bridge'
import { APP_NAME, MENUS, PANEL_WINDOW_PREFIX, type MenuSection } from '@shared/menu'
import { usedAssetIds, type Project } from '@shared/model'
import type { EngineKind } from '@shared/nativeEngine'
import * as audioFiles from './audioFiles'
import { nativeEngineBuilt, nativeEnginePath, startNativeEngine } from './nativeEngine'
import { sfzInstruments } from './sfz'
import { soundFontPresets } from './soundfont'
import { surgePatches, surgePatchState } from './surge'

const PROJECT_FILTERS = [{ name: `${APP_NAME} Project`, extensions: ['studio'] }]
const ALLOWED_PERMISSIONS = ['media', 'midi', 'midiSysex']

// The name shown in the menus, the About panel and dialogs. (When the app is
// not packaged, macOS takes the bold name in the menu bar and the Dock label
// from Electron's own app bundle instead, so those two still say "Electron"
// until the app is packaged.)
app.setName(APP_NAME)
app.setAboutPanelOptions({ applicationName: APP_NAME, applicationVersion: app.getVersion() })
// Settings, autosave and caches stay in the folder they have always been in
// ("studio", the app's first name), so renaming the app loses nothing.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', join(app.getPath('appData'), 'studio'))

// A DAW should be able to make sound without waiting for a click.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let mainWindow: BrowserWindow | null = null
/**
 * Which audio engine the renderer uses. Web Audio unless the app is started
 * with STUDIO_ENGINE=native and the native engine has been built.
 */
let engineKind: EngineKind = 'web'
let documentDirty = false

/** Recordings made before a project has a folder wait here. */
const holdingDir = (): string => join(app.getPath('userData'), 'recordings')
const autosavePath = (): string => join(app.getPath('userData'), 'autosave.json')

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#15171c',
    title: APP_NAME,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Read by the preload script, which has to know before the page's scripts run.
      additionalArguments: [`--studio-engine=${engineKind}`],
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Links never navigate the app window.
  mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
    // A panel brought out into a window of its own: an empty window the page fills in itself.
    if (url === 'about:blank' && frameName.startsWith(PANEL_WINDOW_PREFIX)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: { minWidth: 240, minHeight: 160, backgroundColor: '#15171c', title: APP_NAME, webPreferences: { contextIsolation: true, nodeIntegration: false } }
      }
    }
    if (url.startsWith('https://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const current = mainWindow?.webContents.getURL() ?? ''
    if (new URL(url).origin !== new URL(current).origin || url.startsWith('file:')) event.preventDefault()
  })

  mainWindow.on('close', (event) => {
    if (!documentDirty || !mainWindow) return
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Cancel', 'Discard Changes'],
      defaultId: 0,
      cancelId: 0,
      message: 'This project has unsaved changes.',
      detail: 'Closing now will discard them.'
    })
    if (choice === 0) event.preventDefault()
    else void rm(autosavePath(), { force: true })
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    documentDirty = false
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function send(command: MenuCommand): () => void {
  return () => mainWindow?.webContents.send('menu', command)
}

/** The menu items for a section of the shared menu definition. */
function commandItems(section: MenuSection): MenuItemConstructorOptions[] {
  return section.items.map((item) => (item ? { label: item.label, accelerator: item.accelerator, click: send(item.command) } : { type: 'separator' }))
}

function buildMenu(): void {
  // Items the operating system provides, added after the app's own commands.
  const extras: Record<string, MenuItemConstructorOptions[]> = {
    File: process.platform === 'darwin' ? [] : [{ type: 'separator' }, { role: 'quit' }],
    Edit: [{ type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
  }
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    ...MENUS.map((section) => ({ label: section.label, submenu: [...commandItems(section), ...(extras[section.label] ?? [])] })),
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// ── Files ────────────────────────────────────────────────────────────────

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

/** A file name in `dir` that is not taken, based on `name`. */
async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = basename(name, ext).replace(/[^\w .()-]+/g, '_') || 'audio'
  for (let n = 0; ; n++) {
    const candidate = `${stem}${n ? `-${n}` : ''}${ext}`
    if (!(await exists(join(dir, candidate)))) return candidate
  }
}

/**
 * Brings an audio file into the project's audio folder and returns its file
 * name there. Files from the holding area are moved; anything else is copied.
 */
async function gather(source: string, audioDir: string): Promise<string> {
  const name = basename(source)
  const existing = join(audioDir, name)
  // Already gathered on an earlier save: same name and size.
  const [a, b] = await Promise.all([stat(source), stat(existing).catch(() => null)])
  if (b && a.size === b.size) return name
  const target = await freeName(audioDir, name)
  if (dirname(source) === holdingDir()) {
    await rename(source, join(audioDir, target)).catch(() => copyFile(source, join(audioDir, target)))
  } else {
    await copyFile(source, join(audioDir, target))
  }
  return target
}

ipcMain.handle('project:save', async (_event, request: SaveRequest): Promise<SaveResult | null> => {
  let target = request.path
  if (!target || request.saveAs) {
    const result = await dialog.showSaveDialog(mainWindow!, {
      title: 'Save Project',
      message: 'A folder with this name will hold the project and its audio.',
      buttonLabel: 'Create Project',
      defaultPath: 'Untitled'
    })
    if (result.canceled || !result.filePath) return null
    const folder = result.filePath.replace(/\.studio$/i, '')
    target = join(folder, `${basename(folder)}.studio`)
  }

  const audioDir = join(dirname(target), 'audio')
  await mkdir(audioDir, { recursive: true })

  const project = JSON.parse(request.json) as Project
  const name = basename(target, '.studio')
  project.name = name

  // Gather the audio the project actually uses; drop the rest from the saved file.
  const used = usedAssetIds(project)
  const sourceDir = request.path ? dirname(request.path) : null
  const assetPaths: Record<string, string> = {}
  for (const asset of Object.values(project.assets)) {
    if (!used.has(asset.id)) {
      delete project.assets[asset.id]
      continue
    }
    if (!asset.path) continue
    const source = isAbsolute(asset.path) ? asset.path : sourceDir ? join(sourceDir, asset.path) : null
    if (!source) continue
    try {
      const file = dirname(source) === audioDir ? basename(source) : await gather(source, audioDir)
      asset.path = `audio/${file}`
      assetPaths[asset.id] = asset.path
    } catch {
      // The source is gone; keep the path so the project still says what is missing.
    }
  }

  await writeFile(target, JSON.stringify(project, null, 2), 'utf8')
  return { path: target, name, assetPaths }
})

ipcMain.handle('project:open', async (): Promise<OpenedProject | null> => {
  const result = await dialog.showOpenDialog(mainWindow!, { filters: PROJECT_FILTERS, properties: ['openFile'] })
  const path = result.filePaths[0]
  if (result.canceled || !path) return null
  return { path, json: await readFile(path, 'utf8') }
})

/** The absolute path of an audio asset, or null if it is not an audio file the renderer may touch. */
function audioPath(projectPath: string | null, assetPath: string): string | null {
  if (!AUDIO_EXTENSIONS.includes(extname(assetPath).slice(1).toLowerCase())) return null
  return isAbsolute(assetPath) ? assetPath : projectPath ? join(dirname(projectPath), assetPath) : null
}

ipcMain.handle('audio:read', async (_event, projectPath: string | null, assetPath: string): Promise<ArrayBuffer | null> => {
  const path = audioPath(projectPath, assetPath)
  if (!path) return null
  try {
    const data = await readFile(path)
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  } catch {
    return null
  }
})

ipcMain.handle('audio:probe', async (_event, projectPath: string | null, assetPath: string) => {
  const path = audioPath(projectPath, assetPath)
  return path ? audioFiles.probe(path).catch(() => null) : null
})

ipcMain.handle('audio:readRange', async (_event, projectPath: string | null, assetPath: string, frame: number, count: number) => {
  const path = audioPath(projectPath, assetPath)
  return path ? audioFiles.readRange(path, frame, count) : new ArrayBuffer(0)
})

ipcMain.handle('audio:peaks', async (_event, projectPath: string | null, assetPath: string) => {
  const path = audioPath(projectPath, assetPath)
  return path ? audioFiles.peaks(path).catch(() => null) : null
})

ipcMain.handle('audio:conform', async (_event, projectPath: string | null, assetPath: string, step: ConformStep) => {
  const path = audioPath(projectPath, assetPath)
  if (path) await audioFiles.conform(path, step)
})

ipcMain.handle('audio:writeRecording', async (_event, projectPath: string | null, name: string, data: ArrayBuffer): Promise<string> => {
  const dir = projectPath ? join(dirname(projectPath), 'audio') : holdingDir()
  await mkdir(dir, { recursive: true })
  const file = await freeName(dir, `${basename(name, extname(name))}.wav`)
  await writeFile(join(dir, file), Buffer.from(data))
  return projectPath ? `audio/${file}` : join(dir, file)
})

ipcMain.handle('file:export', async (_event, defaultName: string, data: ArrayBuffer): Promise<string | null> => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    title: 'Export Mixdown',
    defaultPath: basename(defaultName),
    filters: [{ name: 'WAV Audio', extensions: ['wav'] }]
  })
  if (result.canceled || !result.filePath) return null
  await writeFile(result.filePath, Buffer.from(data))
  return result.filePath
})

ipcMain.handle('autosave:write', async (_event, data: string | null): Promise<void> => {
  if (data === null) await rm(autosavePath(), { force: true })
  else await writeFile(autosavePath(), data, 'utf8')
})

ipcMain.handle('autosave:read', (): Promise<string | null> => readFile(autosavePath(), 'utf8').catch(() => null))

ipcMain.handle('soundfont:presets', () => soundFontPresets())

ipcMain.handle('sfz:instruments', () => sfzInstruments())

ipcMain.handle('surge:patches', () => surgePatches())
ipcMain.handle('surge:patchState', (_event, path: string) => surgePatchState(String(path)))

ipcMain.on('window:document', (_event, state: { title: string; dirty: boolean }) => {
  documentDirty = state.dirty
  mainWindow?.setTitle(state.title)
  if (process.platform === 'darwin') mainWindow?.setDocumentEdited(state.dirty)
})

void app.whenReady().then(() => {
  // Microphone and MIDI only; everything else a page could ask for is refused.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.includes(permission)))
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.includes(permission))

  if (process.env.STUDIO_ENGINE === 'native') {
    if (nativeEngineBuilt()) {
      engineKind = 'native'
      startNativeEngine(
        () => mainWindow,
        async (projectPath, assetPath) => {
          const path = audioPath(projectPath, assetPath)
          return path ? audioFiles.streamFile(path).catch(() => null) : null
        }
      )
    } else {
      dialog.showErrorBox(
        'The native audio engine has not been built',
        `${APP_NAME} was started with STUDIO_ENGINE=native, but there is no engine at\n${nativeEnginePath()}\n\nRun "npm run build:native" to build it. ${APP_NAME} will use the Web Audio engine for now.`
      )
    }
  } else if (process.env.STUDIO_ENGINE && process.env.STUDIO_ENGINE !== 'web') {
    console.warn(`STUDIO_ENGINE="${process.env.STUDIO_ENGINE}" is not an engine (use "web" or "native"); using Web Audio.`)
  }

  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
