import { makeEffect, makePluginEffect } from '@shared/effects'
import {
  clipStretch,
  DEFAULT_SAMPLER,
  DEFAULT_SYNTH,
  newId,
  PPQ,
  TRACK_COLORS,
  type AudioClip,
  type AutomationPoint,
  type AutomationTarget,
  type Clip,
  type BuiltInEffectType,
  type Effect,
  type InstrumentType,
  type Id,
  type LoopRegion,
  type Marker,
  type MidiClip,
  type Note,
  type PluginRef,
  type Project,
  type Track,
  type SoundFontPreset
} from '@shared/model'
import { timeMap, type TimeMap } from '@shared/timemap'
import { useStudio } from './store'

const edit = (change: (p: Project) => Project, gesture?: string): void => useStudio.getState().edit(change, gesture)

function mapTrack(project: Project, trackId: Id, fn: (track: Track) => Track): Project {
  return { ...project, tracks: project.tracks.map((t) => (t.id === trackId ? fn(t) : t)) }
}

/** Applies `fn` to the clips with the given ids. Returning an array replaces one clip with several. */
function mapClips(project: Project, ids: readonly Id[], fn: (clip: Clip) => Clip | Clip[]): Project {
  const wanted = new Set(ids)
  return {
    ...project,
    tracks: project.tracks.map((t) =>
      t.clips.some((c) => wanted.has(c.id)) ? { ...t, clips: t.clips.flatMap((c) => (wanted.has(c.id) ? fn(c) : c)) } : t
    )
  }
}

function mapMidiClip(project: Project, clipId: Id, fn: (clip: MidiClip) => MidiClip): Project {
  return mapClips(project, [clipId], (c) => (c.kind === 'midi' ? fn(c) : c))
}

export function findClip(project: Project, clipId: Id | null | undefined): { track: Track; clip: Clip } | null {
  if (!clipId) return null
  for (const track of project.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

// ── Selection ────────────────────────────────────────────────────────────

/** Selects a clip. With `additive`, toggles it within the current selection. */
export function selectClip(clipId: Id, trackId: Id, additive = false): void {
  const { selectedClipIds } = useStudio.getState()
  let next = [clipId]
  if (additive) {
    next = selectedClipIds.includes(clipId) ? selectedClipIds.filter((id) => id !== clipId) : [...selectedClipIds, clipId]
  }
  useStudio.setState({ selectedClipIds: next, selectedTrackId: trackId })
}

/** Drops ids of clips that no longer exist from the selection. */
function pruneSelection(): void {
  const { selectedClipIds, project } = useStudio.getState()
  const kept = selectedClipIds.filter((id) => findClip(project, id))
  if (kept.length !== selectedClipIds.length) useStudio.setState({ selectedClipIds: kept })
}

// ── Tracks ───────────────────────────────────────────────────────────────

export function makeTrack(project: Project, kind: Track['kind']): Track {
  const count = project.tracks.filter((t) => t.kind === kind).length + 1
  return {
    id: newId(),
    name: kind === 'midi' ? `Synth ${count}` : kind === 'bus' ? `Bus ${count}` : `Audio ${count}`,
    kind,
    color: TRACK_COLORS[project.tracks.length % TRACK_COLORS.length],
    volume: 0.8,
    pan: 0,
    mute: false,
    solo: false,
    synth: kind === 'midi' ? { ...DEFAULT_SYNTH } : undefined,
    clips: []
  }
}

export function addTrack(kind: Track['kind']): void {
  const track = makeTrack(useStudio.getState().project, kind)
  edit((p) => ({ ...p, tracks: [...p.tracks, track] }))
  useStudio.setState({ selectedTrackId: track.id })
}

export function updateTrack(trackId: Id, patch: Partial<Track>, gesture?: string): void {
  edit((p) => mapTrack(p, trackId, (t) => ({ ...t, ...patch })), gesture)
}

export function removeTrack(trackId: Id): void {
  edit((p) => ({
    ...p,
    tracks: p.tracks
      .filter((t) => t.id !== trackId)
      // Drop sends that pointed at a removed bus.
      .map((t) => (t.sends?.some((s) => s.busId === trackId) ? { ...t, sends: t.sends.filter((s) => s.busId !== trackId) } : t))
  }))
  const { selectedTrackId } = useStudio.getState()
  if (selectedTrackId === trackId) useStudio.setState({ selectedTrackId: null })
  pruneSelection()
}

// ── Instruments, effects, sends, automation ──────────────────────────────

export function setInstrument(trackId: Id, instrument: InstrumentType): void {
  edit((p) =>
    mapTrack(p, trackId, (t) => ({
      ...t,
      instrument,
      synth: t.synth ?? { ...DEFAULT_SYNTH },
      sampler: t.sampler ?? { ...DEFAULT_SAMPLER }
    }))
  )
}

export function addEffect(trackId: Id, type: BuiltInEffectType): void {
  edit((p) => mapTrack(p, trackId, (t) => ({ ...t, effects: [...(t.effects ?? []), makeEffect(type)] })))
}

export function addPluginEffect(trackId: Id, plugin: PluginRef): void {
  edit((p) => mapTrack(p, trackId, (t) => ({ ...t, effects: [...(t.effects ?? []), makePluginEffect(plugin)] })))
}

/** Makes a plugin the track's instrument, with the settings it starts with. */
export function setInstrumentPlugin(trackId: Id, plugin: PluginRef): void {
  edit((p) => mapTrack(p, trackId, (t) => ({ ...t, instrument: 'plugin', plugin, pluginState: undefined })))
}

/** Makes a preset of the SoundFont the track's instrument. */
export function setInstrumentSoundFont(trackId: Id, soundfont: SoundFontPreset): void {
  edit((p) => mapTrack(p, trackId, (t) => ({ ...t, instrument: 'soundfont', soundfont })))
}

/** Records the settings a plugin reports (`effectId` null for the track's instrument). A run of reports is one undo step. */
export function setPluginState(trackId: Id, effectId: Id | null, state: string): void {
  edit(
    (p) =>
      mapTrack(p, trackId, (t) =>
        effectId === null
          ? t.instrument === 'plugin'
            ? { ...t, pluginState: state }
            : t
          : { ...t, effects: (t.effects ?? []).map((e) => (e.id === effectId && e.type === 'plugin' ? { ...e, state } : e)) }
      ),
    `plugin-state-${trackId}-${effectId}`
  )
}

export function updateEffect(trackId: Id, effectId: Id, patch: Partial<Effect>, gesture?: string): void {
  edit(
    (p) => mapTrack(p, trackId, (t) => ({ ...t, effects: (t.effects ?? []).map((e) => (e.id === effectId ? { ...e, ...patch } : e)) })),
    gesture
  )
}

export function removeEffect(trackId: Id, effectId: Id): void {
  edit((p) => mapTrack(p, trackId, (t) => ({ ...t, effects: (t.effects ?? []).filter((e) => e.id !== effectId) })))
}

export function setSend(trackId: Id, busId: Id, level: number, gesture?: string): void {
  edit(
    (p) =>
      mapTrack(p, trackId, (t) => {
        const others = (t.sends ?? []).filter((s) => s.busId !== busId)
        return { ...t, sends: level > 0 ? [...others, { busId, level }] : others }
      }),
    gesture
  )
}

/** Replaces one automation curve. Points are stored sorted by tick. */
export function setAutomation(trackId: Id, target: AutomationTarget, points: AutomationPoint[], gesture?: string): void {
  const sorted = [...points].sort((a, b) => a.tick - b.tick)
  edit((p) => mapTrack(p, trackId, (t) => ({ ...t, automation: { ...t.automation, [target]: sorted } })), gesture)
}

// ── Clips ────────────────────────────────────────────────────────────────

export function addClip(trackId: Id, clip: Clip): void {
  edit((p) => mapTrack(p, trackId, (t) => ({ ...t, clips: [...t.clips, clip] })))
  useStudio.setState({ selectedClipIds: [clip.id], selectedTrackId: trackId })
}

export function addMidiClip(trackId: Id, start: number, length: number): void {
  addClip(trackId, { id: newId(), kind: 'midi', name: 'Clip', start, length, notes: [] })
}

export function updateClip(clipId: Id, patch: Partial<Omit<AudioClip, 'kind' | 'id'>>, gesture?: string): void {
  edit((p) => mapClips(p, [clipId], (c) => ({ ...c, ...patch }) as Clip), gesture)
}

/**
 * Sets how much an audio clip is stretched. The clip keeps covering the same
 * stretch of the source file, so it gets longer or shorter on the timeline.
 */
export function setClipStretch(clipId: Id, stretch: number, gesture?: string): void {
  const value = Math.min(4, Math.max(0.25, Math.round(stretch * 100) / 100))
  edit((p) => {
    const map = timeMap(p)
    return mapClips(p, [clipId], (c) => {
      if (c.kind !== 'audio') return c
      const seconds = (map.duration(c.start, c.start + c.length) * value) / clipStretch(c).stretch
      return { ...c, stretch: value, length: Math.max(1, Math.round(map.ticksAfter(c.start, seconds))) }
    })
  }, gesture)
}

/** Swaps in a new version of a clip (same id). */
export function replaceClip(clip: Clip, gesture?: string): void {
  edit((p) => mapClips(p, [clip.id], () => clip), gesture)
}

/**
 * Sets new start positions for clips, and optionally moves one of them to
 * another track of the same kind.
 */
export function placeClips(starts: ReadonlyMap<Id, number>, moveTo: { clipId: Id; trackId: Id } | null, gesture: string): void {
  edit((p) => {
    const moving = moveTo ? findClip(p, moveTo.clipId) : null
    const target = moveTo ? p.tracks.find((t) => t.id === moveTo.trackId) : undefined
    const from = moving?.track
    const changesTrack = !!from && !!target && target.id !== from.id && target.kind === from.kind
    const shifts = [...starts].some(([id, start]) => findClip(p, id)?.clip.start !== start)
    // Nothing moved: keep the same object so no undo step is recorded.
    if (!changesTrack && !shifts) return p

    // An audio clip keeps its length in seconds, so its tick length changes if the tempo differs where it lands.
    const map = timeMap(p)
    const next = mapClips(p, [...starts.keys()], (c) => {
      const start = starts.get(c.id)!
      if (c.kind !== 'audio' || start === c.start) return { ...c, start }
      return { ...c, start, length: Math.round(map.ticksAfter(start, map.duration(c.start, c.start + c.length))) }
    })
    if (!changesTrack || !moving || !from || !target) return next
    const clip = findClip(next, moving.clip.id)!.clip
    return {
      ...next,
      tracks: next.tracks.map((t) =>
        t.id === from.id
          ? { ...t, clips: t.clips.filter((c) => c.id !== clip.id) }
          : t.id === target.id
            ? { ...t, clips: [...t.clips, clip] }
            : t
      )
    }
  }, gesture)
}

export function removeClips(ids: readonly Id[]): void {
  const wanted = new Set(ids)
  edit((p) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => !wanted.has(c.id)) })) }))
  pruneSelection()
}

function copyClip(clip: Clip, start: number): Clip {
  return clip.kind === 'midi'
    ? { ...clip, id: newId(), start, notes: clip.notes.map((n) => ({ ...n, id: newId() })) }
    : { ...clip, id: newId(), start }
}

/** Places a copy of each clip directly after the original. */
export function duplicateClips(ids: readonly Id[]): void {
  const copies: Id[] = []
  edit((p) =>
    mapClips(p, ids, (clip) => {
      const copy = copyClip(clip, clip.start + clip.length)
      copies.push(copy.id)
      return [clip, copy]
    })
  )
  if (copies.length) useStudio.setState({ selectedClipIds: copies })
}

/** Cuts each clip that spans `tick` into two. */
export function splitClips(ids: readonly Id[], tick: number): void {
  const at = Math.round(tick)
  edit((p) => {
    const map = timeMap(p)
    let changed = false
    const next = mapClips(p, ids, (clip) => {
      const cut = at - clip.start
      if (cut <= 0 || cut >= clip.length) return clip
      changed = true
      if (clip.kind === 'audio') {
        // The fade in stays with the left half, the fade out with the right.
        return [
          { ...clip, length: cut, fadeOut: 0 },
          { ...clip, id: newId(), start: at, length: clip.length - cut, offset: clip.offset + map.duration(clip.start, at) / clipStretch(clip).stretch, fadeIn: 0 }
        ]
      }
      const left = clip.notes.filter((n) => n.start < cut).map((n) => ({ ...n, length: Math.min(n.length, cut - n.start) }))
      const right = clip.notes.filter((n) => n.start >= cut).map((n) => ({ ...n, id: newId(), start: n.start - cut }))
      return [
        { ...clip, length: cut, notes: left },
        { ...clip, id: newId(), start: at, length: clip.length - cut, notes: right }
      ]
    })
    return changed ? next : p
  })
}

/**
 * The clip with its left edge moved to `start`, its content staying put on
 * the timeline. Null if the edge cannot go there.
 */
export function trimmedStart(clip: Clip, start: number, map: TimeMap): Clip | null {
  const delta = start - clip.start
  const length = clip.length - delta
  if (start < 0 || length < PPQ / 4) return null
  if (clip.kind === 'audio') {
    const offset = clip.offset + map.duration(clip.start, start) / clipStretch(clip).stretch
    return offset < -1e-6 ? null : { ...clip, start, length, offset: Math.max(0, offset) }
  }
  // Notes pushed before the clip start are kept (and silent) so trimming back restores them.
  return { ...clip, start, length, notes: clip.notes.map((n) => ({ ...n, start: n.start - delta })) }
}

// ── Notes ────────────────────────────────────────────────────────────────

export function addNote(clipId: Id, note: Note, gesture?: string): void {
  edit((p) => mapMidiClip(p, clipId, (c) => ({ ...c, notes: [...c.notes, note] })), gesture)
}

export function updateNote(clipId: Id, noteId: Id, patch: Partial<Note>, gesture?: string): void {
  edit(
    (p) => mapMidiClip(p, clipId, (c) => ({ ...c, notes: c.notes.map((n) => (n.id === noteId ? { ...n, ...patch } : n)) })),
    gesture
  )
}

export function removeNote(clipId: Id, noteId: Id): void {
  edit((p) => mapMidiClip(p, clipId, (c) => ({ ...c, notes: c.notes.filter((n) => n.id !== noteId) })))
}

/** Applies `fn` to the chosen notes of a clip, or to every note when `ids` is empty. */
export function updateNotes(clipId: Id, ids: readonly Id[], fn: (note: Note) => Note, gesture?: string): void {
  const wanted = new Set(ids)
  edit((p) => mapMidiClip(p, clipId, (c) => ({ ...c, notes: c.notes.map((n) => (!wanted.size || wanted.has(n.id) ? fn(n) : n)) })), gesture)
}

export function removeNotes(clipId: Id, ids: readonly Id[]): void {
  const wanted = new Set(ids)
  edit((p) => mapMidiClip(p, clipId, (c) => ({ ...c, notes: c.notes.filter((n) => !wanted.has(n.id)) })))
  useStudio.setState({ selectedNoteIds: [] })
}

/** Moves note starts onto the grid. Lengths are left alone. */
export function quantiseNotes(clipId: Id, ids: readonly Id[], grid: number): void {
  updateNotes(clipId, ids, (n) => {
    const start = Math.max(0, Math.round(n.start / grid) * grid)
    return start === n.start ? n : { ...n, start }
  })
}

export function transposeNotes(clipId: Id, ids: readonly Id[], semitones: number): void {
  updateNotes(clipId, ids, (n) => ({ ...n, pitch: Math.min(127, Math.max(0, n.pitch + semitones)) }))
}

// ── Project settings ─────────────────────────────────────────────────────

const clampBpm = (bpm: number): number => Math.min(300, Math.max(20, Math.round(bpm * 100) / 100))

/**
 * Applies a change to the tempo map. Audio plays at its own speed whatever
 * the tempo, so each audio clip is resized to cover the same seconds as before.
 */
function editTempo(change: (p: Project) => Project): void {
  edit((p) => {
    const next = change(p)
    if (next === p) return p
    const before = timeMap(p)
    const after = timeMap(next)
    return {
      ...next,
      tracks: next.tracks.map((t) =>
        t.kind !== 'audio'
          ? t
          : {
              ...t,
              clips: t.clips.map((c) => ({
                ...c,
                length: Math.max(1, Math.round(after.ticksAfter(c.start, before.duration(c.start, c.start + c.length))))
              }))
            }
      )
    }
  })
}

/** Sets a tempo: `id` null is the tempo at the start of the project. */
export function setTempo(id: Id | null, bpm: number): void {
  const value = clampBpm(bpm)
  editTempo((p) => {
    if (id === null) return p.bpm === value ? p : { ...p, bpm: value }
    return { ...p, tempoChanges: (p.tempoChanges ?? []).map((c) => (c.id === id ? { ...c, bpm: value } : c)) }
  })
}

/** Adds a tempo change at a tick, starting out at the tempo already in force there. */
export function addTempoChange(tick: number): void {
  if (tick <= 0) return
  editTempo((p) => {
    const changes = p.tempoChanges ?? []
    if (changes.some((c) => c.tick === tick)) return p
    return { ...p, tempoChanges: [...changes, { id: newId(), tick, bpm: timeMap(p).tempoAt(tick).bpm }] }
  })
}

export function removeTempoChange(id: Id): void {
  editTempo((p) => ({ ...p, tempoChanges: (p.tempoChanges ?? []).filter((c) => c.id !== id) }))
}

const DENOMINATORS = [2, 4, 8, 16]

/** Sets a time signature: `id` null is the one at the start of the project. False if it is not a usable signature. */
export function setMeter(id: Id | null, numerator: number, denominator: number): boolean {
  if (!Number.isInteger(numerator) || numerator < 1 || numerator > 32 || !DENOMINATORS.includes(denominator)) return false
  edit((p) => {
    if (id === null) return { ...p, beatsPerBar: numerator, beatUnit: denominator }
    return { ...p, meterChanges: (p.meterChanges ?? []).map((c) => (c.id === id ? { ...c, numerator, denominator } : c)) }
  })
  return true
}

/** Adds a time-signature change at a bar (0-based), starting out as the signature already in force. */
export function addMeterChange(bar: number): void {
  if (bar <= 0) return
  edit((p) => {
    const changes = p.meterChanges ?? []
    if (changes.some((c) => c.bar === bar)) return p
    const map = timeMap(p)
    const meter = map.meterAt(map.barStart(bar))
    return { ...p, meterChanges: [...changes, { id: newId(), bar, numerator: meter.numerator, denominator: meter.denominator }] }
  })
}

export function removeMeterChange(id: Id): void {
  edit((p) => ({ ...p, meterChanges: (p.meterChanges ?? []).filter((c) => c.id !== id) }))
}

export function addMarker(tick: number): void {
  const at = Math.max(0, Math.round(tick))
  edit((p) => {
    const markers = p.markers ?? []
    if (markers.some((m) => m.tick === at)) return p
    return { ...p, markers: [...markers, { id: newId(), tick: at, name: `Marker ${markers.length + 1}` }] }
  })
}

export function updateMarker(id: Id, patch: Partial<Marker>): void {
  edit((p) => ({ ...p, markers: (p.markers ?? []).map((m) => (m.id === id ? { ...m, ...patch } : m)) }))
}

export function removeMarker(id: Id): void {
  edit((p) => ({ ...p, markers: (p.markers ?? []).filter((m) => m.id !== id) }))
}

export function setLoop(patch: Partial<LoopRegion>, gesture?: string): void {
  edit((p) => ({ ...p, loop: { ...p.loop, ...patch } }), gesture)
}
