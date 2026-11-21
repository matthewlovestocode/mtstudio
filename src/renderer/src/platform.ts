/**
 * Files and menus. Uses the Electron bridge when present and falls back to
 * browser equivalents, so the renderer also runs in a plain browser tab.
 */
import { AUDIO_EXTENSIONS, type MenuCommand, type StudioBridge } from '@shared/bridge'
import { APP_NAME } from '@shared/menu'
import { DEFAULT_SAMPLER, newId, type AudioAsset, type AudioClip, type Id, type Project } from '@shared/model'
import { decodePcm, type StreamInfo } from '@shared/pcm'
import { timeMap } from '@shared/timemap'
import { engine } from './engine'
import type { AssetInfo, AudioStream } from './engine/types'
import { addTrack, makeTrack, splitClips } from './state/actions'
import { emptyProject } from './state/demo'
import { assetInfo, useStudio } from './state/store'

declare global {
  interface Window {
    studio?: StudioBridge
  }
}

export const bridge = window.studio

function confirmDiscard(): boolean {
  return !useStudio.getState().dirty || window.confirm('Discard unsaved changes?')
}

function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.onchange = () => resolve(Array.from(input.files ?? []))
    input.oncancel = () => resolve([])
    input.click()
  })
}

// ── Loading audio ────────────────────────────────────────────────────────

/**
 * When a file is played from disk rather than loaded into memory. Short files
 * are quicker and simpler to keep in memory; long ones would use about 10 MB
 * a minute.
 */
export const streaming = {
  /** Files at least this long are streamed. */
  minSeconds: 60,
  /** Compressed files at least this big are decoded once to a cached WAV and streamed from that. */
  conformBytes: 8 * 1024 * 1024
}

/** An audio file to load: picked or dropped (`file`), or known only by where it is on disk (`path`). */
interface AudioSource {
  name: string
  path?: string
  file?: File
}

function diskStream(info: StreamInfo, projectPath: string | null, path: string): AudioStream {
  return {
    sampleRate: info.sampleRate,
    channels: info.channels,
    frames: info.frames,
    file: { projectPath, path },
    read: async (frame, count) => decodePcm(new Uint8Array(await bridge!.readAudioRange(projectPath, path, frame, count)), info)
  }
}

/** Decodes a compressed file and stores the samples as a WAV in the cache, ten seconds at a time. */
async function conform(data: ArrayBuffer, projectPath: string | null, path: string): Promise<void> {
  const decoded = await new OfflineAudioContext(2, 1, 48000).decodeAudioData(data)
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => decoded.getChannelData(c))
  await bridge!.conformAudio(projectPath, path, { type: 'begin', sampleRate: decoded.sampleRate, channels: channels.length, frames: decoded.length })
  const step = decoded.sampleRate * 10
  for (let from = 0; from < decoded.length; from += step) {
    const frames = Math.min(step, decoded.length - from)
    const interleaved = new Float32Array(frames * channels.length)
    for (let c = 0; c < channels.length; c++) {
      for (let i = 0; i < frames; i++) interleaved[i * channels.length + c] = channels[c][from + i]
    }
    await bridge!.conformAudio(projectPath, path, { type: 'data', data: interleaved.buffer })
  }
  await bridge!.conformAudio(projectPath, path, { type: 'end' })
}

/**
 * Makes an audio file playable under `assetId`: streamed from disk if it is
 * long, otherwise decoded into memory. `inMemory` forces the latter, for uses
 * that need the samples to hand (a sampler). Throws if the file cannot be read.
 */
async function loadAudio(assetId: Id, source: AudioSource, projectPath: string | null, inMemory = false): Promise<AssetInfo> {
  const { path, file } = source
  const read = async (): Promise<ArrayBuffer> => {
    const data = file ? await file.arrayBuffer() : path && bridge ? await bridge.readAudioFile(projectPath, path) : null
    if (!data) throw new Error('missing')
    return data
  }

  if (bridge && path && !inMemory) {
    let probe = await bridge.probeAudio(projectPath, path)
    if (probe && !probe.stream && probe.bytes >= streaming.conformBytes) {
      await conform(await read(), projectPath, path)
      probe = await bridge.probeAudio(projectPath, path)
    }
    const info = probe?.stream
    if (info && info.frames / info.sampleRate >= streaming.minSeconds) {
      const overview = await bridge.audioPeaks(projectPath, path)
      if (overview) {
        engine.loadAssetStream(assetId, diskStream(info, projectPath, path))
        return { duration: overview.duration, peaks: new Float32Array(overview.peaks), secondsPerPeak: overview.secondsPerPeak }
      }
    }
  }
  return engine.loadAsset(assetId, await read())
}

// ── Audio import ─────────────────────────────────────────────────────────

/**
 * Loads the files and places them end to end as clips, on `trackId` if it is
 * an audio track, otherwise on a new audio track.
 */
export function importAudioFiles(files: File[], trackId?: Id, startTick = 0): Promise<void> {
  const sources = files.map((file) => ({ name: file.name, file, path: bridge?.pathForFile(file) || undefined }))
  return importAudio(sources, trackId, startTick)
}

/** The same, for files known by their path on disk. */
export function importAudioPaths(paths: string[], trackId?: Id, startTick = 0): Promise<void> {
  return importAudio(paths.map((path) => ({ name: path.split(/[\\/]/).pop() ?? path, path })), trackId, startTick)
}

async function importAudio(sources: AudioSource[], trackId?: Id, startTick = 0): Promise<void> {
  let position = startTick
  let targetId = trackId
  for (const source of sources) {
    const assetId = newId()
    let info
    try {
      info = await loadAudio(assetId, source, useStudio.getState().filePath)
    } catch {
      window.alert(`Could not read "${source.name}".`)
      continue
    }
    assetInfo.set(assetId, info)

    const { project, edit } = useStudio.getState()
    const asset: AudioAsset = { id: assetId, name: source.name, path: source.path, duration: info.duration }
    const clip: AudioClip = {
      id: newId(),
      kind: 'audio',
      name: source.name.replace(/\.[^.]+$/, ''),
      assetId,
      start: position,
      length: Math.round(timeMap(project).ticksAfter(position, info.duration)),
      offset: 0
    }
    const existing = project.tracks.find((t) => t.id === targetId && t.kind === 'audio')
    const track = existing ?? makeTrack(project, 'audio')
    targetId = track.id
    edit((p) => ({
      ...p,
      assets: { ...p.assets, [assetId]: asset },
      tracks: existing
        ? p.tracks.map((t) => (t.id === track.id ? { ...t, clips: [...t.clips, clip] } : t))
        : [...p.tracks, { ...track, clips: [clip] }]
    }))
    useStudio.setState((s) => ({ selectedClipIds: [clip.id], selectedTrackId: track.id, assetsVersion: s.assetsVersion + 1 }))
    position += clip.length
  }
}

export async function importAudioDialog(): Promise<void> {
  const files = await pickFiles(AUDIO_EXTENSIONS.map((e) => `.${e}`).join(','), true)
  const { selectedTrackId } = useStudio.getState()
  await importAudioFiles(files, selectedTrackId ?? undefined, engine.getPosition())
}

/** Loads audio for assets the engine does not have yet (after opening a project). */
async function loadMissingAssets(project: Project, projectPath: string | null): Promise<void> {
  if (!bridge) return
  const missing: string[] = []
  // A sampler needs its sample in memory, however long it is.
  const sampled = new Set(project.tracks.map((t) => t.sampler?.assetId))
  for (const asset of Object.values(project.assets)) {
    if (engine.hasAsset(asset.id)) continue
    try {
      assetInfo.set(asset.id, await loadAudio(asset.id, { name: asset.name, path: asset.path }, projectPath, sampled.has(asset.id)))
      useStudio.setState((s) => ({ assetsVersion: s.assetsVersion + 1 }))
    } catch {
      missing.push(asset.name)
    }
  }
  if (missing.length) window.alert(`Missing audio files:\n${missing.join('\n')}`)
}

/** Asks for an audio file and loads it into a track's sampler. */
export async function loadSampleDialog(trackId: Id): Promise<void> {
  const [file] = await pickFiles(AUDIO_EXTENSIONS.map((e) => `.${e}`).join(','), false)
  if (!file) return
  const assetId = newId()
  let info
  try {
    info = await engine.loadAsset(assetId, await file.arrayBuffer())
  } catch {
    window.alert(`Could not decode "${file.name}".`)
    return
  }
  assetInfo.set(assetId, info)
  const asset: AudioAsset = { id: assetId, name: file.name, path: bridge?.pathForFile(file) || undefined, duration: info.duration }
  useStudio.getState().edit((p) => ({
    ...p,
    assets: { ...p.assets, [assetId]: asset },
    tracks: p.tracks.map((t) => (t.id === trackId ? { ...t, sampler: { ...DEFAULT_SAMPLER, ...t.sampler, assetId } } : t))
  }))
}

// ── Project files ────────────────────────────────────────────────────────

function parseProject(json: string): Project | null {
  try {
    const data = JSON.parse(json) as Project
    if (data?.version !== 1 || !Array.isArray(data.tracks) || typeof data.bpm !== 'number') return null
    return data
  } catch {
    return null
  }
}

function load(json: string, path: string | null): void {
  const project = parseProject(json)
  if (!project) {
    window.alert(`That file is not a ${APP_NAME} project.`)
    return
  }
  show(project, path)
}

function show(project: Project, path: string | null): void {
  engine.stop()
  engine.seek(0)
  useStudio.getState().loadProject(project, path)
  void loadMissingAssets(project, path)
}

export function newProject(): void {
  if (!confirmDiscard()) return
  show(emptyProject(), null)
}

export async function openProject(): Promise<void> {
  if (!confirmDiscard()) return
  if (bridge) {
    const opened = await bridge.openProject()
    if (opened) load(opened.json, opened.path)
    return
  }
  const [file] = await pickFiles('.studio,application/json', false)
  if (file) load(await file.text(), null)
}

export async function saveProject(saveAs = false): Promise<void> {
  const { project, filePath } = useStudio.getState()
  const json = JSON.stringify(project, null, 2)
  if (!bridge) {
    download(new Blob([json], { type: 'application/json' }), `${project.name}.studio`)
    useStudio.setState({ dirty: false })
    return
  }
  const saved = await bridge.saveProject({ path: filePath, saveAs, json })
  if (!saved) return
  // Saving gathers audio into the project folder; adopt the new paths without an undo step.
  useStudio.setState((s) => ({
    filePath: saved.path,
    dirty: s.project !== project,
    project: {
      ...s.project,
      name: saved.name,
      assets: Object.fromEntries(
        Object.entries(s.project.assets).map(([id, asset]) => [id, saved.assetPaths[id] ? { ...asset, path: saved.assetPaths[id] } : asset])
      )
    }
  }))
}

function download(blob: Blob, name: string): void {
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = name
  link.click()
  URL.revokeObjectURL(link.href)
}

export async function exportMixdown(): Promise<void> {
  let wav: ArrayBuffer
  try {
    wav = await engine.renderMixdown()
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'The export failed.')
    return
  }
  const name = `${useStudio.getState().project.name}.wav`
  if (bridge) await bridge.exportFile(name, wav)
  else download(new Blob([wav], { type: 'audio/wav' }), name)
}

// ── Autosave ─────────────────────────────────────────────────────────────

const AUTOSAVE_INTERVAL = 15_000

interface Autosave {
  filePath: string | null
  savedAt: string
  project: Project
}

/** Offers to restore work from a session that did not end cleanly, then keeps a snapshot going. */
export async function initAutosave(): Promise<void> {
  if (!bridge) return
  const stored = await bridge.readAutosave()
  if (stored) {
    try {
      const autosave = JSON.parse(stored) as Autosave
      const when = new Date(autosave.savedAt).toLocaleString()
      if (parseProject(JSON.stringify(autosave.project)) && window.confirm(`${APP_NAME} did not close cleanly.\nRecover unsaved work from ${when}?`)) {
        show(autosave.project, autosave.filePath)
        useStudio.setState({ dirty: true })
      } else {
        await bridge.writeAutosave(null)
      }
    } catch {
      await bridge.writeAutosave(null)
    }
  }

  let written: Project | null = null
  setInterval(() => {
    const { project, dirty, filePath } = useStudio.getState()
    if (!dirty) {
      if (written) void bridge.writeAutosave(null)
      written = null
    } else if (project !== written) {
      written = project
      const autosave: Autosave = { filePath, savedAt: new Date().toISOString(), project }
      void bridge.writeAutosave(JSON.stringify(autosave))
    }
  }, AUTOSAVE_INTERVAL)
}

export function runCommand(command: MenuCommand): void {
  const state = useStudio.getState()
  switch (command) {
    case 'new':
      return newProject()
    case 'open':
      return void openProject()
    case 'save':
      return void saveProject()
    case 'saveAs':
      return void saveProject(true)
    case 'undo':
      return state.undo()
    case 'redo':
      return state.redo()
    case 'importAudio':
      return void importAudioDialog()
    case 'export':
      return void exportMixdown()
    case 'split':
      return splitClips(state.selectedClipIds, engine.getPosition())
    case 'addInstrumentTrack':
      return addTrack('midi')
    case 'addAudioTrack':
      return addTrack('audio')
    case 'addBus':
      return addTrack('bus')
  }
}
