/**
 * Carries out the tools of src/shared/mcp.ts: each call from an assistant
 * arrives here from the main process and goes through the same actions the
 * window's own controls use, so it is seen as it happens and can be undone.
 *
 * Callers speak in beats (quarter notes); the project is kept in ticks.
 */
import { EFFECTS, effectParam, makeEffect } from '@shared/effects'
import { keyAt } from '@shared/keymap'
import { AUTOMATION_RANGE, DEFAULT_SYNTH, newId, PPQ, type AutomationTarget, type BuiltInEffectType, type Clip, type MidiClip, type Note, type Project, type Track, type Waveform } from '@shared/model'
import type { McpAnswer } from '@shared/mcp'
import { keyName, noteName, SCALES, type Key, type ScaleId } from '@shared/theory'
import { timeMap } from '@shared/timemap'
import { isDrumTrack, kitFor, kitNameFor, patternNotes, PATTERNS, type Pattern } from './drums'
import { engine } from './engine'
import { barChords } from './harmony'
import { currentItemId, loadLibrary } from './library'
import { partNotes, PARTS, roomFor, type Part } from './parts'
import { bridge, saveProject, showNewProject, showOpened } from './platform'
import { DRUM_BANK, refreshSfzInstruments } from './soundfont'
import {
  duplicateClips,
  findClip,
  makeTrack,
  placeClips,
  removeClips,
  removeEffect,
  removeTrack,
  replaceClip,
  setAutomation,
  setInstrumentSoundFont,
  setKey,
  setLoop,
  setMeter,
  setSend,
  setTempo,
  updateClip,
  updateEffect,
  updateTrack
} from './state/actions'
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

// ── Sound: instruments, effects, sends, automation ───────────────────────

function effectOf(track: Track, id: unknown): NonNullable<Track['effects']>[number] {
  const effect = (track.effects ?? []).find((each) => each.id === id)
  if (!effect) throw new Refused(`"${track.name}" has no effect with the id "${String(id)}". get_track lists them.`)
  return effect
}

/** Parameters as a caller gives them, checked against what that kind of effect has. */
function effectParams(type: BuiltInEffectType, given: unknown): Record<string, number> {
  if (given === undefined || given === null) return {}
  if (typeof given !== 'object' || Array.isArray(given)) throw new Refused('"params" must be an object of numbers.')
  const defs = EFFECTS[type].params
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(given as Args)) {
    const def = defs.find((each) => each.key === key)
    if (!def) throw new Refused(`${EFFECTS[type].label} has no "${key}". It has: ${defs.map((each) => each.key).join(', ')}.`)
    if (typeof value !== 'number' || !Number.isFinite(value) || value < def.min || value > def.max) throw new Refused(`${EFFECTS[type].label}'s "${key}" runs from ${def.min} to ${def.max}${def.unit === '%' ? '' : ` ${def.unit}`}.`)
    out[key] = value
  }
  return out
}

function describeTrack(args: Args): unknown {
  const track = trackOf(args)
  const p = project()
  const name = (id: string): string => p.tracks.find((each) => each.id === id)?.name ?? id
  const kind = track.instrument ?? 'synth'
  const drums = track.kind === 'midi' && isDrumTrack(track)
  return {
    id: track.id,
    name: track.name,
    kind: track.kind === 'midi' ? 'instrument' : track.kind,
    volume: track.volume,
    pan: track.pan,
    mute: track.mute,
    solo: track.solo,
    ...(track.kind === 'midi'
      ? {
          instrument: instrumentOf(track),
          instrument_id: currentItemId(track, []),
          ...(kind === 'synth' ? { synth: track.synth ?? DEFAULT_SYNTH } : {}),
          drums,
          ...(drums ? { drum_notes: Object.fromEntries(Object.entries(kitFor(track).names).map(([pitch, each]) => [pitch, each])) } : {})
        }
      : {}),
    effects: (track.effects ?? []).map((effect) => ({
      id: effect.id,
      type: effect.type,
      ...(effect.type === 'plugin' ? { plugin: effect.plugin?.name } : { params: Object.fromEntries(EFFECTS[effect.type].params.map((def) => [def.key, effectParam(effect, def.key)])) }),
      bypass: effect.bypass
    })),
    sends: (track.sends ?? []).map((send) => ({ bus_id: send.busId, bus: name(send.busId), level: send.level })),
    automation: Object.fromEntries(
      (['volume', 'pan'] as AutomationTarget[]).filter((target) => track.automation?.[target]?.length).map((target) => [target, track.automation![target]!.map((point) => ({ at: beats(point.tick), value: point.value }))])
    ),
    clips: track.clips.length
  }
}

/** Every word of the search must be somewhere in the text. */
const matches = (search: string | undefined, ...texts: (string | undefined)[]): boolean => {
  if (!search) return true
  const hay = texts.join(' ').toLowerCase()
  return search
    .toLowerCase()
    .split(/\s+/)
    .every((word) => hay.includes(word))
}
const same = (a: string | undefined, b: string): boolean => a !== undefined && a.trim().toLowerCase() === b.toLowerCase()

/** The pattern or part of a name, where there is exactly one. */
function oneNamed<T extends { name: string; style: string }>(all: T[], name: string | undefined, style: string | undefined, what: string, lister: string): T {
  if (!name) throw new Refused(`Which ${what}? ${lister} lists them.`)
  const found = all.filter((each) => same(name, each.name) && (!style || same(style, each.style)))
  if (found.length === 1) return found[0]
  if (found.length > 1) throw new Refused(`There is a ${what} called "${name}" in more than one style (${found.map((each) => each.style).join(', ')}). Say which with "style".`)
  const near = all.filter((each) => matches(name, each.name, each.style)).slice(0, 8)
  throw new Refused(`There is no ${what} called "${name}"${style ? ` in ${style}` : ''}.${near.length ? ` Near it: ${near.map((each) => `"${each.name}" (${each.style})`).join(', ')}.` : ` ${lister} lists them.`}`)
}

const counts = <T>(all: T[], key: (each: T) => string): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const each of all) out[key(each)] = (out[key(each)] ?? 0) + 1
  return out
}

const SOUND_TOOLS: Record<string, (args: Args) => unknown | Promise<unknown>> = {
  get_track: describeTrack,

  async list_instruments(args) {
    const search = text(args, 'search')
    const family = text(args, 'family')
    const source = text(args, 'source')
    const limit = number(args, 'limit', 1, 200) ?? 40
    const library = await loadLibrary()
    const found = library.items.filter((each) => (!family || same(family, each.family)) && (!source || same(source, each.source)) && matches(search, each.name, each.detail, each.family))
    return {
      matched: found.length,
      shown: Math.min(found.length, limit),
      ...(library.nativeOnly ? { note: 'mtstudio is running on its Web Audio engine, which plays only the three built-in instruments.' } : {}),
      ...(found.length > limit ? { more: 'Narrow it with search, family or source to see the rest.' } : {}),
      instruments: found.slice(0, limit).map((each) => ({ id: each.id, name: each.name, family: each.family, source: each.source, detail: each.detail }))
    }
  },

  async set_instrument(args) {
    const track = trackOf(args)
    if (track.kind !== 'midi') throw new Refused(`"${track.name}" is not an instrument track.`)
    const id = text(args, 'instrument_id')
    const library = await loadLibrary()
    const item = library.items.find((each) => each.id === args.instrument_id) ?? library.items.find((each) => same(id, each.name))
    if (!item) throw new Refused(`There is no instrument with the id "${String(args.instrument_id)}". list_instruments finds them.`)
    if (library.nativeOnly && item.source !== 'Built in') throw new Refused('mtstudio is running on its Web Audio engine, which plays only the three built-in instruments.')
    await item.apply(track.id)
    return done(`"${track.name}" now plays ${item.name} (${item.source}).`)
  },

  set_synth(args) {
    const track = trackOf(args)
    if (track.kind !== 'midi' || (track.instrument ?? 'synth') !== 'synth') throw new Refused(`"${track.name}" does not play the built-in synth. set_instrument with "builtin:synth" gives it one.`)
    const patch: Record<string, number | string> = {}
    if (args.wave !== undefined) {
      if (!['sine', 'triangle', 'sawtooth', 'square'].includes(args.wave as string)) throw new Refused('"wave" must be sine, triangle, sawtooth or square.')
      patch.wave = args.wave as Waveform
    }
    const ranges: Record<string, [number, number]> = { attack: [0.001, 1], decay: [0.01, 2], sustain: [0, 1], release: [0.01, 3], cutoff: [80, 16000], resonance: [0.1, 20] }
    for (const [key, [min, max]] of Object.entries(ranges)) {
      const value = number(args, key, min, max)
      if (value !== undefined) patch[key] = value
    }
    if (Object.keys(patch).length === 0) throw new Refused('Nothing to change was given.')
    const synth = { ...(track.synth ?? DEFAULT_SYNTH), ...patch }
    updateTrack(track.id, { synth })
    return done(`Changed the synth on "${track.name}".`, { synth })
  },

  add_effect(args) {
    const track = trackOf(args)
    const type = args.type as BuiltInEffectType
    if (!(typeof type === 'string' && type in EFFECTS)) throw new Refused(`"type" must be one of: ${Object.keys(EFFECTS).join(', ')}.`)
    const effect = makeEffect(type, effectParams(type, args.params))
    useStudio.getState().edit((p) => ({ ...p, tracks: p.tracks.map((each) => (each.id === track.id ? { ...each, effects: [...(each.effects ?? []), effect] } : each)) }))
    return done(`Added ${EFFECTS[type].label} to "${track.name}".`, { effect_id: effect.id, params: effect.params })
  },

  update_effect(args) {
    const track = trackOf(args)
    const effect = effectOf(track, args.effect_id)
    const bypass = flag(args, 'bypass')
    if (effect.type === 'plugin' && args.params !== undefined) throw new Refused("A plugin's settings are changed in its own window.")
    const params = effect.type === 'plugin' ? {} : effectParams(effect.type, args.params)
    if (bypass === undefined && Object.keys(params).length === 0) throw new Refused('Nothing to change was given.')
    updateEffect(track.id, effect.id, { ...(bypass === undefined ? {} : { bypass }), ...(Object.keys(params).length ? { params: { ...effect.params, ...params } } : {}) })
    return done(`Changed the ${effect.type === 'plugin' ? 'plugin' : EFFECTS[effect.type].label} on "${track.name}".`)
  },

  remove_effect(args) {
    const track = trackOf(args)
    const effect = effectOf(track, args.effect_id)
    removeEffect(track.id, effect.id)
    return done(`Removed the ${effect.type === 'plugin' ? 'plugin' : EFFECTS[effect.type].label} from "${track.name}".`)
  },

  set_send(args) {
    const track = trackOf(args)
    const bus = trackOf(args, 'bus_id')
    if (bus.kind !== 'bus') throw new Refused(`"${bus.name}" is not a bus. add_track with the kind "bus" makes one.`)
    if (track.kind === 'bus') throw new Refused('A bus cannot be sent to a bus.')
    const level = need(number(args, 'level', 0, 1), 'level')
    setSend(track.id, bus.id, level)
    return done(level > 0 ? `"${track.name}" is sent to "${bus.name}" at ${level}.` : `"${track.name}" is no longer sent to "${bus.name}".`)
  },

  set_automation(args) {
    const track = trackOf(args)
    const target = args.target as AutomationTarget
    if (target !== 'volume' && target !== 'pan') throw new Refused('"target" must be "volume" or "pan".')
    if (!Array.isArray(args.points)) throw new Refused('"points" must be a list.')
    if (args.points.length > 2000) throw new Refused('At most 2000 points.')
    const range = AUTOMATION_RANGE[target]
    const points = args.points.map((each, index) => {
      const given = (each ?? {}) as Args
      if (typeof given.at !== 'number' || !Number.isFinite(given.at) || given.at < 0) throw new Refused(`Point ${index + 1}: "at" must be 0 or more beats.`)
      if (typeof given.value !== 'number' || !Number.isFinite(given.value) || given.value < range.min || given.value > range.max) throw new Refused(`Point ${index + 1}: ${range.label.toLowerCase()} runs from ${range.min} to ${range.max}.`)
      return { id: newId(), tick: ticks(given.at), value: given.value }
    })
    setAutomation(track.id, target, points)
    return done(points.length ? `"${track.name}" has a ${target} curve of ${points.length} points, which it follows while playing.` : `Removed the ${target} curve from "${track.name}".`)
  },

  list_patterns(args) {
    const style = text(args, 'style')
    const search = text(args, 'search')
    if (!style && !search) return { patterns: PATTERNS.length, styles: counts(PATTERNS, (each) => each.style), next: 'Give a style or words to search for to see the patterns.' }
    const found = PATTERNS.filter((each) => (!style || same(style, each.style)) && matches(search, each.name, each.style, each.group))
    if (!found.length && style && !PATTERNS.some((each) => same(style, each.style))) throw new Refused(`There is no style called "${style}". The styles are: ${Object.keys(counts(PATTERNS, (each) => each.style)).join(', ')}.`)
    return { matched: found.length, patterns: found.slice(0, 120).map((each) => ({ name: each.name, style: each.style, ...(each.group ? { group: each.group } : {}), bpm: each.bpm, kit: kitNameFor(each) })) }
  },

  async apply_pattern(args) {
    const { track, clip } = midiClipOf(args.clip_id)
    if (!isDrumTrack(track)) throw new Refused(`"${track.name}" is not a drum track, so a pattern's notes would not land on drums. Give it a drum kit first (list_instruments with the family "Drums"), or use apply_part for a pitched instrument.`)
    const pattern: Pattern = oneNamed(PATTERNS, text(args, 'pattern'), text(args, 'style'), 'pattern', 'list_patterns')
    const grow = flag(args, 'grow') ?? true
    const matchKit = flag(args, 'match_kit') ?? true
    // As the step sequencer does it: a track on the drum machine or a SoundFont kit is moved to the pattern's kit; one playing anything else was put there by hand and stays.
    const instrument = track.instrument ?? 'synth'
    const onSoundFont = instrument === 'soundfont' && track.soundfont?.bank === DRUM_BANK
    const kits = matchKit && (instrument === 'drums' || onSoundFont) && bridge?.nativeEngine ? (((await bridge.soundFontPresets().catch(() => null)) ?? []).filter((each) => each.bank === DRUM_BANK)) : []
    const wanted = kits.find((each) => each.name === kitNameFor(pattern))
    const moving = wanted && !(onSoundFont && track.soundfont!.program === wanted.program)
    const gesture = `mcp-${newId()}`
    if (moving) setInstrumentSoundFont(track.id, wanted, gesture)
    const p = project()
    const now = midiClipOf(clip.id).clip
    const length = grow ? roomFor(p, track, now) : now.length
    const notes = patternNotes(pattern, moving ? kitFor({ ...track, instrument: 'soundfont', soundfont: wanted }) : kitFor(track), length)
    replaceClip({ ...now, length, notes }, gesture)
    useStudio.getState().endGesture()
    return done(`Wrote "${pattern.name}" (${pattern.style}) into "${clip.name}": ${notes.length} hits over ${beats(length)} beats.`, {
      suits_bpm: pattern.bpm,
      tempo_now: p.bpm,
      ...(moving ? { kit: `The track now plays the ${wanted.name} kit.` } : {})
    })
  },

  list_parts(args) {
    const style = text(args, 'style')
    const kind = text(args, 'kind')
    const search = text(args, 'search')
    if (!style && !kind && !search) return { parts: PARTS.length, styles: counts(PARTS, (each) => each.style), kinds: counts(PARTS, (each) => each.kind), next: 'Give a style, a kind or words to search for to see the parts.' }
    const found = PARTS.filter((each) => (!style || same(style, each.style)) && (!kind || same(kind, each.kind)) && matches(search, each.name, each.style, each.group))
    if (!found.length && style && !PARTS.some((each) => same(style, each.style))) throw new Refused(`There is no style called "${style}". The styles are: ${Object.keys(counts(PARTS, (each) => each.style)).join(', ')}.`)
    return { matched: found.length, parts: found.map((each) => ({ name: each.name, style: each.style, kind: each.kind, group: each.group, bpm: each.bpm })) }
  },

  apply_part(args) {
    const { track, clip } = midiClipOf(args.clip_id)
    if (isDrumTrack(track)) throw new Refused(`"${track.name}" is a drum track; parts are for pitched instruments. Use apply_pattern here.`)
    const part: Part = oneNamed(PARTS, text(args, 'part'), text(args, 'style'), 'part', 'list_parts')
    const grow = flag(args, 'grow') ?? true
    const p = project()
    const length = grow ? roomFor(p, track, clip) : clip.length
    const notes = partNotes(part, p, track, clip, length)
    replaceClip({ ...clip, length, notes })
    const pitches = notes.map((note) => note.pitch)
    return done(`Wrote "${part.name}" (${part.style}, ${part.kind}) into "${clip.name}": ${notes.length} notes over ${beats(length)} beats.`, {
      ...(pitches.length ? { range: `${noteName(Math.min(...pitches), keyAt(p, clip.start))} to ${noteName(Math.max(...pitches), keyAt(p, clip.start))}` } : {}),
      suits_bpm: part.bpm,
      tempo_now: p.bpm
    })
  }
}

// ── Files, packs ─────────────────────────────────────────────────────────

/** How long and how loud a rendered WAV is: its peak and its average (RMS) level, in dB below full scale. */
function loudness(wav: ArrayBuffer): { seconds: number; peak_dbfs: number | null; average_dbfs: number | null } | null {
  const view = new DataView(wav)
  let format = 0
  let channels = 0
  let rate = 0
  let bits = 0
  for (let at = 12; at + 8 <= view.byteLength; ) {
    const name = String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3))
    const size = view.getUint32(at + 4, true)
    if (name === 'fmt ') {
      format = view.getUint16(at + 8, true)
      channels = view.getUint16(at + 10, true)
      rate = view.getUint32(at + 12, true)
      bits = view.getUint16(at + 22, true)
    } else if (name === 'data' && channels && rate) {
      const bytes = bits / 8
      const count = Math.floor(Math.min(size, view.byteLength - at - 8) / bytes)
      let peak = 0
      let squares = 0
      for (let i = 0, offset = at + 8; i < count; i++, offset += bytes) {
        const sample = format === 3 && bits === 32 ? view.getFloat32(offset, true) : bits === 24 ? ((view.getInt8(offset + 2) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset)) / 8388608 : bits === 16 ? view.getInt16(offset, true) / 32768 : 0
        const size = Math.abs(sample)
        if (size > peak) peak = size
        squares += sample * sample
      }
      const db = (level: number): number | null => (level > 0 ? Math.round(20 * Math.log10(level) * 10) / 10 : null)
      return { seconds: Math.round((count / channels / rate) * 100) / 100, peak_dbfs: db(peak), average_dbfs: db(Math.sqrt(squares / Math.max(1, count))) }
    }
    at += 8 + size + (size & 1)
  }
  return null
}

/** Refuses to replace the open project while it has changes that are not saved, unless told they may go. */
function mayReplace(args: Args): void {
  if (useStudio.getState().dirty && flag(args, 'discard_unsaved_changes') !== true) {
    throw new Refused('The open project has unsaved changes, which this would lose. Ask the user, then either save_project first or pass discard_unsaved_changes: true.')
  }
}

const FILE_TOOLS: Record<string, (args: Args) => unknown | Promise<unknown>> = {
  async save_project() {
    if (!bridge) throw new Refused('mtstudio is running in a browser tab, where it cannot save to disk.')
    const had = useStudio.getState().filePath
    await saveProject()
    const { filePath, dirty } = useStudio.getState()
    if (!filePath) throw new Refused('The project has never been saved, and the user closed the dialog that asks where to put it. Nothing was saved.')
    if (dirty && !had) throw new Refused('The user closed the dialog without choosing a place. Nothing was saved.')
    return done(`Saved to ${filePath}.`, { path: filePath })
  },

  async list_recent_projects() {
    const paths = (await bridge?.recentProjects()) ?? []
    return { open_now: useStudio.getState().filePath, projects: paths.map((path) => ({ name: path.split(/[\\/]/).pop()?.replace(/\.studio$/i, ''), path })) }
  },

  async open_project(args) {
    if (!bridge) throw new Refused('mtstudio is running in a browser tab, where it cannot open files.')
    mayReplace(args)
    const path = args.path === undefined || args.path === null ? null : String(args.path)
    const opened = path ? await bridge.openRecentProject(path) : await bridge.openProject()
    if (!opened) throw new Refused(path ? `"${path}" is not a project the user has opened or saved in mtstudio before, or it is no longer there. list_recent_projects says which are; with no path, the user is asked to pick.` : 'The user closed the dialog without picking a project.')
    if (!showOpened(opened.json, opened.path)) throw new Refused('That file is not an mtstudio project.')
    const p = project()
    return done(`Opened "${p.name}": ${p.tracks.length} tracks at ${p.bpm} bpm. Every id is new; call get_project.`, { path: opened.path })
  },

  new_project(args) {
    mayReplace(args)
    showNewProject()
    return done('Started an empty project. It has no tracks yet.')
  },

  async export_mixdown() {
    const state = useStudio.getState()
    if (engine.isRecording()) throw new Refused('mtstudio is recording; stop it first.')
    const wav = await engine.renderMixdown()
    const heard = loudness(wav)
    const name = `${state.project.name}.wav`
    if (!bridge) throw new Refused('mtstudio is running in a browser tab, where it cannot write the file.')
    const path = (state.filePath ? await bridge.exportBeside(state.filePath, name, wav) : null) ?? (await bridge.exportFile(name, wav))
    if (!path) throw new Refused('The mix was rendered, but the user closed the dialog that asks where to put it, so no file was written.')
    const silent = heard && heard.peak_dbfs === null
    return done(`Exported the mix to ${path}.`, {
      path,
      ...(heard ?? {}),
      megabytes: Math.round(wav.byteLength / 1e4) / 100,
      ...(silent ? { warning: 'The mix is silent: nothing sounded. Check for muted tracks, a solo, or instruments with no sound loaded.' } : {}),
      ...(heard && heard.peak_dbfs !== null && heard.peak_dbfs >= 0 ? { warning: 'The mix reaches full scale and will clip. Bring the faders down.' } : {})
    })
  },

  async list_packs(args) {
    const search = text(args, 'search')
    const packs = ((await bridge?.contentPacks()) ?? []).filter((each) => matches(search, each.name, each.kind, each.description))
    return {
      packs: packs.map((each) => ({
        id: each.id,
        name: each.name,
        kind: each.kind,
        megabytes: each.megabytes,
        license: each.license,
        credit: each.credit,
        description: each.description,
        state: each.installed ? 'installed' : each.installing ? 'installing' : 'not installed'
      }))
    }
  },

  async install_pack(args) {
    if (!bridge) throw new Refused('mtstudio is running in a browser tab, where it cannot install packs.')
    const pack = (await bridge.contentPacks()).find((each) => each.id === args.pack_id)
    if (!pack) throw new Refused(`There is no pack with the id "${String(args.pack_id)}". list_packs lists them.`)
    if (pack.installed) return done(`${pack.name} is already installed.`)
    if (pack.installing) return done(`${pack.name} is already being installed.`)
    // Not waited for: a pack is hundreds of megabytes. The list of instruments is read again when it lands.
    void bridge
      .installPack(pack.id)
      .catch(() => null)
      .then(() => refreshSfzInstruments())
    return done(`Started installing ${pack.name} (${pack.megabytes} MB, ${pack.license}). list_packs shows when it is done.`)
  }
}

const TOOLS: Record<string, (args: Args) => unknown | Promise<unknown>> = {
  ...SOUND_TOOLS,
  ...FILE_TOOLS,
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
