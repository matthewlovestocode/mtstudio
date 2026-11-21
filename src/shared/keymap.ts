/**
 * The key along the timeline: the one the project starts in and the changes
 * of key after it, as stretches each with one key. Everything that goes by
 * the key asks here which is in force at a given tick.
 */
import type { Id, Project, Track } from './model'
import { guessKeys, type Key } from './theory'
import { timeMap } from './timemap'

export interface KeySegment {
  /** The change that begins it; null for the key the project starts in. */
  id: Id | null
  /** The bar it begins at, counting from 0, and where that is in ticks. */
  bar: number
  tick: number
  /** Where the next begins; Infinity for the last. */
  end: number
  key: Key
  /** Worked out from the notes, not chosen: it will follow them as they change. Only ever the first stretch. */
  auto: boolean
}

/** A drum track's notes are sounds, not pitches, and say nothing about the key. */
function pitched(track: Track): boolean {
  if (track.kind !== 'midi' || track.instrument === 'drums') return false
  if (track.instrument === 'soundfont' && track.soundfont?.bank === 128) return false
  return !/drum|kit\b|beat|perc|808|909/i.test(`${track.name} ${track.sfz?.name ?? ''} ${track.sfz?.pack ?? ''} ${track.pluginPatch ?? ''}`)
}

/** How well the notes must fit a key before it is taken to be the song's without being asked. */
const SURE_ENOUGH = 0.5

/** Asked for on every frame and every render, so the answer is kept for as long as the tracks are the same. */
const worked = new WeakMap<Track[], Key | null>()

/**
 * The key the notes written so far are in, when no key has been chosen: the
 * song's key until one is. Null while there is too little to tell by, or
 * nothing fits well.
 */
export function autoKey(project: Project): Key | null {
  const known = worked.get(project.tracks)
  if (known !== undefined) return known
  const notes = project.tracks.filter(pitched).flatMap((track) => track.clips.flatMap((clip) => (clip.kind === 'midi' ? clip.notes : [])))
  const best = guessKeys(notes)[0]
  const key = best && best.fit >= SURE_ENOUGH ? best.key : null
  worked.set(project.tracks, key)
  return key
}

/**
 * The stretches of the song by key, in order. The first is in the key that
 * was chosen for the song, or failing that the key its notes are in. Empty
 * if there is neither: changes of key mean nothing without one to change from.
 */
export function keySegments(project: Project): KeySegment[] {
  const first = project.key ?? autoKey(project)
  if (!first) return []
  const map = timeMap(project)
  const changes = [...(project.keyChanges ?? [])].filter((change) => change.bar > 0).sort((a, b) => a.bar - b.bar)
  const starts: Omit<KeySegment, 'end'>[] = [{ id: null, bar: 0, tick: 0, key: first, auto: !project.key }]
  for (const change of changes) {
    // Two at one bar: the later-made stands.
    if (starts[starts.length - 1].bar === change.bar) starts.pop()
    starts.push({ id: change.id, bar: change.bar, tick: map.barStart(change.bar), key: change.key, auto: false })
  }
  return starts.map((segment, i) => ({ ...segment, end: starts[i + 1]?.tick ?? Infinity }))
}

/** The stretch a tick falls in, from segments already worked out. */
export function segmentAt(segments: KeySegment[], tick: number): KeySegment | null {
  let found: KeySegment | null = segments[0] ?? null
  for (const segment of segments) if (segment.tick <= tick) found = segment
  return found
}

/** The key in force at a tick; null if the project has none. */
export function keyAt(project: Project, tick: number): Key | null {
  return segmentAt(keySegments(project), tick)?.key ?? null
}
