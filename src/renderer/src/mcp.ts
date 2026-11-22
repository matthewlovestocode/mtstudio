/**
 * Carries out the tools of src/shared/mcp.ts: each call from an assistant
 * arrives here from the main process and goes through the same actions the
 * window's own controls use, so it is seen as it happens and can be undone.
 *
 * Callers speak in beats (quarter notes); the project is kept in ticks.
 */
import { keyAt } from '@shared/keymap'
import { newId, PPQ, type Clip, type MidiClip, type Note, type Project, type Track } from '@shared/model'
import type { McpAnswer } from '@shared/mcp'
import { keyName, noteName, SCALES, type Key, type ScaleId } from '@shared/theory'
import { timeMap } from '@shared/timemap'
import { isDrumTrack } from './drums'
import { engine } from './engine'
import { barChords } from './harmony'
import { duplicateClips, findClip, makeTrack, placeClips, removeClips, removeTrack, replaceClip, setKey, setLoop, setMeter, setTempo, updateClip, updateTrack } from './state/actions'
import { useStudio } from './state/store'

type Args = Record<string, unknown>

const beats = (ticks: number): number => Math.round((ticks / PPQ) * 10000) / 10000
const ticks = (value: number): number => Math.round(value * PPQ)
const project = (): Project => useStudio.getState().project

/** A problem with what was asked for, said to the caller as it is. */
class Refused extends Error {}

function number(args: Args, name: string, min: number, max: number): number | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Refused(`"${name}" must be a number from ${min} to ${max}.`)
  return value
}
function need<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Refused(`"${name}" is needed.`)
  return value
}
function text(args: Args, name: string): string | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw new Refused(`"${name}" must be text.`)
  return value.trim().slice(0, 80)
}
function flag(args: Args, name: string): boolean | undefined {
  const value = args[name]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'boolean') throw new Refused(`"${name}" must be true or false.`)
  return value
}
function ids(args: Args, name: string): string[] {
  const value = args[name]
  if (!Array.isArray(value) || value.length === 0 || value.some((each) => typeof each !== 'string')) throw new Refused(`"${name}" must be a list of ids.`)
  return value as string[]
}

function trackOf(args: Args, name = 'track_id'): Track {
  const id = args[name]
  const track = project().tracks.find((each) => each.id === id)
  if (!track) throw new Refused(`There is no track with the id "${String(id)}". get_project lists them.`)
  return track
}
function clipOf(id: unknown): { track: Track; clip: Clip } {
  const found = typeof id === 'string' ? findClip(project(), id) : null
  if (!found) throw new Refused(`There is no clip with the id "${String(id)}". get_project lists them.`)
  return found
}
function midiClipOf(id: unknown): { track: Track; clip: MidiClip } {
  const { track, clip } = clipOf(id)
  if (clip.kind !== 'midi') throw new Refused('That clip holds audio, not notes.')
  return { track, clip }
}

const MAX_NOTES = 5000
/** Notes as a caller gives them, made into the project's own. Those that start past the end of the clip are refused, so nothing is written that would never sound. */
function notesFrom(value: unknown, clipLength: number): Note[] {
  if (!Array.isArray(value)) throw new Refused('"notes" must be a list.')
  if (value.length > MAX_NOTES) throw new Refused(`At most ${MAX_NOTES} notes at a time.`)
  return value.map((each, index) => {
    const given = (each ?? {}) as Args
    const where = `Note ${index + 1}`
    const pitch = given.pitch
    if (typeof pitch !== 'number' || !Number.isInteger(pitch) || pitch < 0 || pitch > 127) throw new Refused(`${where}: "pitch" must be a whole number from 0 to 127.`)
    const start = given.start
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) throw new Refused(`${where}: "start" must be 0 or more beats.`)
    const length = given.length
    if (typeof length !== 'number' || !Number.isFinite(length) || length <= 0) throw new Refused(`${where}: "length" must be more than 0 beats.`)
    const velocity = given.velocity ?? 0.8
    if (typeof velocity !== 'number' || !Number.isFinite(velocity) || velocity < 0 || velocity > 1) throw new Refused(`${where}: "velocity" must be from 0 to 1.`)
    if (ticks(start) >= clipLength) throw new Refused(`${where} starts at beat ${start}, past the end of the clip (${beats(clipLength)} beats). Make the clip longer first.`)
    return { id: newId(), pitch, start: ticks(start), length: Math.max(1, ticks(length)), velocity }
  })
}

const ROOTS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
function rootFrom(name: string): number {
  const match = /^([A-Ga-g])([#♯b♭]?)$/.exec(name.trim())
  if (!match) throw new Refused(`"${name}" is not a note name. Use one like C, F# or Bb.`)
  const shift = match[2] === '' ? 0 : match[2] === '#' || match[2] === '♯' ? 1 : -1
  return (ROOTS[match[1].toUpperCase()] + shift + 12) % 12
}

const instrumentOf = (track: Track): string | undefined => {
  if (track.kind !== 'midi') return undefined
  const kind = track.instrument ?? 'synth'
  if (kind === 'soundfont') return track.soundfont ? `${track.soundfont.name} (SoundFont)` : 'SoundFont'
  if (kind === 'sfz') return track.sfz ? `${track.sfz.name} (SFZ)` : 'SFZ'
  if (kind === 'plugin') return track.plugin ? `${track.pluginPatch ?? track.plugin.name} (plugin)` : 'plugin'
  return kind === 'drums' ? 'drum machine' : kind
}

function describeProject(): unknown {
  const state = useStudio.getState()
  const p = state.project
  const map = timeMap(p)
  return {
    name: p.name,
    file: state.filePath,
    unsaved_changes: state.dirty,
    tempo_bpm: p.bpm,
    tempo_changes: (p.tempoChanges ?? []).map((change) => ({ at: beats(change.tick), bpm: change.bpm })),
    time_signature: `${p.beatsPerBar}/${p.beatUnit ?? 4}`,
    beats_per_bar: beats(map.barAt(0).length),
    key: p.key ? keyName(p.key) : null,
    loop: { enabled: p.loop.enabled, start: beats(p.loop.start), end: beats(p.loop.end) },
    playing: engine.isPlaying(),
    playhead: beats(engine.getPosition()),
    can_undo: state.past.length > 0,
    can_redo: state.future.length > 0,
    tracks: p.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      kind: track.kind === 'midi' ? 'instrument' : track.kind,
      instrument: instrumentOf(track),
      drums: track.kind === 'midi' ? isDrumTrack(track) : undefined,
      volume: track.volume,
      pan: track.pan,
      mute: track.mute,
      solo: track.solo,
      clips: [...track.clips]
        .sort((a, b) => a.start - b.start)
        .map((clip) => ({
          id: clip.id,
          name: clip.name,
          kind: clip.kind === 'midi' ? 'notes' : 'audio',
          start: beats(clip.start),
          length: beats(clip.length),
          bar: map.barAt(clip.start).index + 1,
          notes: clip.kind === 'midi' ? clip.notes.length : undefined
        }))
    }))
  }
}

function describeClip(args: Args): unknown {
  const { track, clip } = clipOf(args.clip_id)
  const p = project()
  const base = { id: clip.id, name: clip.name, track_id: track.id, track: track.name, start: beats(clip.start), length: beats(clip.length) }
  if (clip.kind !== 'midi') return { ...base, kind: 'audio' }
  const key = keyAt(p, clip.start)
  const bars = timeMap(p)
    .barsUntil(clip.start + clip.length)
    .filter((bar) => bar.start + bar.length > clip.start)
  const chords = isDrumTrack(track) ? [] : barChords(p, track, clip, bars, (tick) => keyAt(p, tick))
  return {
    ...base,
    kind: 'notes',
    drums: isDrumTrack(track),
    key: key ? keyName(key) : null,
    chords: chords.map((chord, index) => (chord ? { bar: bars[index].index + 1, chord: chord.name, numeral: chord.numeral, from_other_tracks: chord.borrowed } : { bar: bars[index].index + 1, chord: null })),
    notes: [...clip.notes]
      .sort((a, b) => a.start - b.start || a.pitch - b.pitch)
      .map((note) => ({ id: note.id, pitch: note.pitch, name: noteName(note.pitch, key), start: beats(note.start), length: beats(note.length), velocity: Math.round(note.velocity * 100) / 100 }))
  }
}

const done = (what: string, more: Record<string, unknown> = {}): unknown => ({ done: what, ...more })

const TOOLS: Record<string, (args: Args) => unknown | Promise<unknown>> = {
  get_project: describeProject,
  get_clip: describeClip,

  add_track(args) {
    const kind = args.kind === 'instrument' ? 'midi' : args.kind === 'audio' || args.kind === 'bus' ? args.kind : null
    if (!kind) throw new Refused('"kind" must be "instrument", "audio" or "bus".')
    const name = text(args, 'name')
    const track = { ...makeTrack(project(), kind), ...(name ? { name } : {}) }
    useStudio.getState().edit((p) => ({ ...p, tracks: [...p.tracks, track] }))
    useStudio.setState({ selectedTrackId: track.id })
    return done(`Added the ${args.kind} track "${track.name}".`, { track_id: track.id })
  },

  update_track(args) {
    const track = trackOf(args)
    const patch: Partial<Track> = {}
    const name = text(args, 'name')
    if (name) patch.name = name
    const volume = number(args, 'volume', 0, 1.5)
    if (volume !== undefined) patch.volume = volume
    const pan = number(args, 'pan', -1, 1)
    if (pan !== undefined) patch.pan = pan
    const mute = flag(args, 'mute')
    if (mute !== undefined) patch.mute = mute
    const solo = flag(args, 'solo')
    if (solo !== undefined) patch.solo = solo
    if (Object.keys(patch).length === 0) throw new Refused('Nothing to change was given.')
    updateTrack(track.id, patch)
    return done(`Changed the track "${patch.name ?? track.name}".`)
  },

  remove_track(args) {
    const track = trackOf(args)
    removeTrack(track.id)
    return done(`Removed the track "${track.name}" and its ${track.clips.length} clips. undo brings it back.`)
  },

  add_clip(args) {
    const track = trackOf(args)
    if (track.kind !== 'midi') throw new Refused(`"${track.name}" is ${track.kind === 'bus' ? 'a bus' : 'an audio track'}; clips of notes go on instrument tracks.`)
    const start = ticks(need(number(args, 'start', 0, 100000), 'start'))
    const length = Math.max(1, ticks(need(number(args, 'length', 0, 100000), 'length')))
    const clip: MidiClip = { id: newId(), kind: 'midi', name: text(args, 'name') || 'Clip', start, length, notes: args.notes === undefined ? [] : notesFrom(args.notes, length) }
    const overlapped = track.clips.filter((other) => other.start < start + length && other.start + other.length > start)
    useStudio.getState().edit((p) => ({ ...p, tracks: p.tracks.map((each) => (each.id === track.id ? { ...each, clips: [...each.clips, clip] } : each)) }))
    useStudio.setState({ selectedClipIds: [clip.id], selectedTrackId: track.id })
    return done(`Added a clip of ${clip.notes.length} notes to "${track.name}".`, {
      clip_id: clip.id,
      ...(overlapped.length ? { warning: `It overlaps ${overlapped.length === 1 ? `the clip "${overlapped[0].name}"` : `${overlapped.length} other clips`} on that track; both will sound.` } : {})
    })
  },

  update_clip(args) {
    const { track, clip } = clipOf(args.clip_id)
    const name = text(args, 'name')
    const start = number(args, 'start', 0, 100000)
    const length = number(args, 'length', 0, 100000)
    const to = args.track_id === undefined || args.track_id === null ? null : trackOf(args)
    if (to && to.kind !== track.kind) throw new Refused(`A clip of ${clip.kind === 'midi' ? 'notes' : 'audio'} cannot go on "${to.name}".`)
    if (length !== undefined && length <= 0) throw new Refused('"length" must be more than 0 beats.')
    if (!name && start === undefined && length === undefined && !to) throw new Refused('Nothing to change was given.')
    // One gesture, so that however much changes it is one step of undo.
    const gesture = `mcp-${newId()}`
    if (start !== undefined || (to && to.id !== track.id)) {
      placeClips(new Map([[clip.id, start === undefined ? clip.start : ticks(start)]]), to && to.id !== track.id ? { clipId: clip.id, trackId: to.id } : null, gesture)
    }
    if (name || length !== undefined) updateClip(clip.id, { ...(name ? { name } : {}), ...(length !== undefined ? { length: Math.max(1, ticks(length)) } : {}) }, gesture)
    useStudio.getState().endGesture()
    return done(`Changed the clip "${name ?? clip.name}".`)
  },

  remove_clips(args) {
    const wanted = ids(args, 'clip_ids')
    for (const id of wanted) clipOf(id)
    removeClips(wanted)
    return done(`Removed ${wanted.length} ${wanted.length === 1 ? 'clip' : 'clips'}.`)
  },

  duplicate_clips(args) {
    const wanted = ids(args, 'clip_ids')
    for (const id of wanted) clipOf(id)
    const before = new Set(project().tracks.flatMap((track) => track.clips.map((clip) => clip.id)))
    duplicateClips(wanted)
    const made = project()
      .tracks.flatMap((track) => track.clips)
      .filter((clip) => !before.has(clip.id))
    return done(`Made ${made.length} ${made.length === 1 ? 'copy' : 'copies'}.`, { clips: made.map((clip) => ({ clip_id: clip.id, start: beats(clip.start) })) })
  },

  set_clip_notes(args) {
    const { clip } = midiClipOf(args.clip_id)
    const notes = notesFrom(args.notes, clip.length)
    replaceClip({ ...clip, notes })
    return done(`"${clip.name}" now holds ${notes.length} notes (it had ${clip.notes.length}).`)
  },

  add_notes(args) {
    const { clip } = midiClipOf(args.clip_id)
    const notes = notesFrom(args.notes, clip.length)
    if (clip.notes.length + notes.length > MAX_NOTES * 4) throw new Refused('That is more notes than a clip is meant to hold.')
    replaceClip({ ...clip, notes: [...clip.notes, ...notes] })
    return done(`Added ${notes.length} ${notes.length === 1 ? 'note' : 'notes'} to "${clip.name}".`, { note_ids: notes.map((note) => note.id) })
  },

  remove_notes(args) {
    const { clip } = midiClipOf(args.clip_id)
    const wanted = new Set(ids(args, 'note_ids'))
    const kept = clip.notes.filter((note) => !wanted.has(note.id))
    if (kept.length === clip.notes.length) throw new Refused('None of those note ids are in the clip. get_clip lists them.')
    replaceClip({ ...clip, notes: kept })
    return done(`Removed ${clip.notes.length - kept.length} of the ${clip.notes.length} notes in "${clip.name}".`)
  },

  set_tempo(args) {
    setTempo(null, need(number(args, 'bpm', 20, 300), 'bpm'))
    return done(`The tempo is ${project().bpm} beats per minute.`)
  },

  set_time_signature(args) {
    const numerator = need(number(args, 'numerator', 1, 32), 'numerator')
    const denominator = need(number(args, 'denominator', 2, 16), 'denominator')
    if (!setMeter(null, numerator, denominator)) throw new Refused('That is not a time signature mtstudio can use: the top is a whole number from 1 to 32, the bottom 2, 4, 8 or 16.')
    return done(`The time signature is ${numerator}/${denominator}.`)
  },

  set_key(args) {
    const root = text(args, 'root')
    const scale = text(args, 'scale')
    if (!root && !scale) {
      setKey(null)
      return done('The key is cleared.')
    }
    if (!root || !scale) throw new Refused('A key needs both "root" and "scale"; leave both out to clear it.')
    if (!(scale in SCALES)) throw new Refused(`"${scale}" is not a scale mtstudio knows: ${Object.keys(SCALES).join(', ')}.`)
    const key: Key = { root: rootFrom(root), scale: scale as ScaleId }
    setKey(key)
    return done(`The key is ${keyName(key)}.`)
  },

  set_loop(args) {
    const enabled = flag(args, 'enabled')
    const start = number(args, 'start', 0, 100000)
    const end = number(args, 'end', 0, 100000)
    if (enabled === undefined && start === undefined && end === undefined) throw new Refused('Nothing to change was given.')
    const loop = project().loop
    const next = { enabled: enabled ?? loop.enabled, start: start === undefined ? loop.start : ticks(start), end: end === undefined ? loop.end : ticks(end) }
    if (next.end <= next.start) throw new Refused(`The loop would end (beat ${beats(next.end)}) at or before it starts (beat ${beats(next.start)}).`)
    setLoop(next)
    return done(`Looping is ${next.enabled ? 'on' : 'off'}, from beat ${beats(next.start)} to beat ${beats(next.end)}.`)
  },

  async transport(args) {
    const position = number(args, 'position', 0, 100000)
    if (args.action === 'stop') {
      engine.stop()
      return done('Stopped.', { playhead: beats(engine.getPosition()) })
    }
    if (args.action === 'seek') {
      engine.seek(ticks(need(position, 'position')))
      return done(`The playhead is at beat ${position}.`)
    }
    if (args.action === 'play') {
      if (engine.isRecording()) throw new Refused('mtstudio is recording; stop it first.')
      if (position !== undefined) engine.seek(ticks(position))
      if (!engine.isPlaying()) await engine.play()
      return done(`Playing from beat ${beats(engine.getPosition())}. You cannot hear it; the user can.`)
    }
    throw new Refused('"action" must be "play", "stop" or "seek".')
  },

  undo() {
    const state = useStudio.getState()
    if (!state.past.length) throw new Refused('There is nothing to undo.')
    state.undo()
    return done('Undone.')
  },

  redo() {
    const state = useStudio.getState()
    if (!state.future.length) throw new Refused('There is nothing to redo.')
    state.redo()
    return done('Redone.')
  }
}

/** Carries out one call. */
export async function runMcpTool(name: string, args: unknown): Promise<McpAnswer> {
  const tool = TOOLS[name]
  if (!tool) return { ok: false, error: `mtstudio has no tool called "${name}".` }
  try {
    return { ok: true, value: await tool(args && typeof args === 'object' ? (args as Args) : {}) }
  } catch (error) {
    if (error instanceof Refused) return { ok: false, error: error.message }
    console.error(`[mcp] ${name} failed`, error)
    return { ok: false, error: `mtstudio could not do that: ${error instanceof Error ? error.message : String(error)}` }
  }
}
