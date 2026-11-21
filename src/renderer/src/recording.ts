/**
 * Arming, recording and the play/stop toggle. Audio takes are captured by the
 * engine; MIDI takes are collected here from live note input.
 */
import { newId, type AudioAsset, type AudioClip, type Id, type Note } from '@shared/model'
import { setLayout } from './components/layout'
import { engine, nativeEngine } from './engine'
import { bridge } from './platform'
import { timeMap } from '@shared/timemap'
import { addClip } from './state/actions'
import { assetInfo, useStudio } from './state/store'

interface MidiTake {
  trackId: Id
  notes: Note[]
  /** Notes still held down, by pitch. */
  open: Map<number, Note>
}

let midiTake: MidiTake | null = null
let takeCount = 0

function armedTrack() {
  const { project, armedTrackId } = useStudio.getState()
  return project.tracks.find((t) => t.id === armedTrackId) ?? null
}

/** Arms a track for recording, or disarms it if it is already armed. */
export async function toggleArm(trackId: Id): Promise<void> {
  const { project, armedTrackId, monitor, recordingFrom } = useStudio.getState()
  if (recordingFrom !== null) return
  const track = project.tracks.find((t) => t.id === trackId)
  if (track?.kind === 'bus') return
  if (!track || armedTrackId === trackId) {
    await engine.setInput(null, false)
    useStudio.setState({ armedTrackId: null })
    return
  }
  try {
    // Audio tracks need the input open; MIDI tracks do not.
    await engine.setInput(track.kind === 'audio' ? trackId : null, monitor)
  } catch (error) {
    // The engine says what went wrong (no access, a microphone it cannot use); failing that, the general advice.
    const reason = error instanceof Error && error.message ? error.message : 'Check that a microphone is connected and that access is allowed.'
    window.alert(`The track could not be armed for recording.\n\n${reason}`)
    return
  }
  useStudio.setState({ armedTrackId: trackId, selectedTrackId: trackId })
}

/**
 * Records from another microphone (null for the system's default). If a
 * track is armed, it is armed again so the change takes effect at once.
 */
export async function chooseInput(name: string | null): Promise<void> {
  setLayout({ inputDevice: name })
  await nativeEngine?.chooseInput(name)
  const track = armedTrack()
  if (track?.kind !== 'audio' || useStudio.getState().recordingFrom !== null) return
  try {
    await engine.setInput(track.id, useStudio.getState().monitor)
  } catch (error) {
    useStudio.setState({ armedTrackId: null })
    window.alert(`That microphone could not be opened, so the track is no longer armed.\n\n${error instanceof Error ? error.message : ''}`)
  }
}

export async function toggleMonitor(): Promise<void> {
  const monitor = !useStudio.getState().monitor
  useStudio.setState({ monitor })
  const track = armedTrack()
  if (track?.kind === 'audio') await engine.setInput(track.id, monitor)
}

/** Called when the armed track disappears (deleted, undone, project replaced). */
export function disarmIfGone(): void {
  if (useStudio.getState().armedTrackId && !armedTrack()) {
    void engine.setInput(null, false)
    useStudio.setState({ armedTrackId: null })
  }
}

export async function toggleRecord(): Promise<void> {
  if (useStudio.getState().recordingFrom !== null) return finishRecording()

  // Recording with nothing armed arms the selected track.
  if (!armedTrack()) {
    const { selectedTrackId } = useStudio.getState()
    if (selectedTrackId) await toggleArm(selectedTrackId)
  }
  const track = armedTrack()
  if (!track) {
    window.alert('Arm a track to record: press the R button on a track.')
    return
  }
  if (engine.isPlaying()) engine.stop()
  await engine.startRecording(track.kind === 'audio')
  if (track.kind === 'midi') midiTake = { trackId: track.id, notes: [], open: new Map() }
  useStudio.setState({ recordingFrom: engine.getPosition() })
}

async function finishRecording(): Promise<void> {
  const { recordingFrom, project, filePath } = useStudio.getState()
  const end = engine.getPosition()
  const take = await engine.stopRecording()
  const midi = midiTake
  midiTake = null
  useStudio.setState({ recordingFrom: null })
  const track = armedTrack()
  if (!track || recordingFrom === null) return

  if (midi) {
    for (const note of midi.open.values()) note.length = Math.max(1, end - note.start)
    if (!midi.notes.length) return
    // The clip runs from the bar the take began in to the end of the bar it stopped in.
    const map = timeMap(project)
    const start = map.barAt(recordingFrom).start
    const last = map.barAt(end)
    const length = last.start + last.length - start
    const notes = midi.notes.map((n) => ({ ...n, start: Math.round(n.start - start), length: Math.round(n.length) }))
    addClip(track.id, { id: newId(), kind: 'midi', name: 'Take', start, length, notes })
    return
  }

  if (!take) return
  const name = `${track.name} take ${++takeCount}`
  // Write first: decoding consumes the buffer.
  const path = bridge ? await bridge.writeRecording(filePath, name, take.wav) : undefined
  const assetId = newId()
  const info = await engine.loadAsset(assetId, take.wav)
  assetInfo.set(assetId, info)
  const playable = info.duration - take.offset
  if (playable <= 0.02) return

  const asset: AudioAsset = { id: assetId, name: `${name}.wav`, path, duration: info.duration }
  const clip: AudioClip = {
    id: newId(),
    kind: 'audio',
    name,
    assetId,
    start: Math.round(take.startTick),
    length: Math.round(timeMap(project).ticksAfter(take.startTick, playable)),
    offset: take.offset
  }
  useStudio.getState().edit((p) => ({
    ...p,
    assets: { ...p.assets, [assetId]: asset },
    tracks: p.tracks.map((t) => (t.id === track.id ? { ...t, clips: [...t.clips, clip] } : t))
  }))
  useStudio.setState((s) => ({ selectedClipIds: [clip.id], assetsVersion: s.assetsVersion + 1 }))
}

/** Space bar: stop if anything is running (keeping a take in progress), otherwise play. */
export function togglePlay(): void {
  if (useStudio.getState().recordingFrom !== null) void finishRecording()
  else if (engine.isPlaying()) engine.stop()
  else void engine.play()
}

// ── MIDI capture, fed by midiInput.ts ────────────────────────────────────

export function captureNoteOn(trackId: Id, pitch: number, velocity: number): void {
  if (!midiTake || midiTake.trackId !== trackId) return
  captureNoteOff(trackId, pitch)
  const note: Note = { id: newId(), pitch, velocity, start: engine.getPosition(), length: 0 }
  midiTake.notes.push(note)
  midiTake.open.set(pitch, note)
}

export function captureNoteOff(trackId: Id, pitch: number): void {
  const note = midiTake?.trackId === trackId ? midiTake.open.get(pitch) : undefined
  if (!midiTake || !note) return
  note.length = Math.max(1, engine.getPosition() - note.start)
  midiTake.open.delete(pitch)
}
