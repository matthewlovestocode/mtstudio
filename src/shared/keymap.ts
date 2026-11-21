/**
 * The key along the timeline: the one the project starts in and the changes
 * of key after it, as stretches each with one key. Everything that goes by
 * the key asks here which is in force at a given tick.
 */
import type { Id, Project } from './model'
import type { Key } from './theory'
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
}

/** The stretches of the song by key, in order. Empty if the project has no key: changes of key mean nothing without one to change from. */
export function keySegments(project: Project): KeySegment[] {
  if (!project.key) return []
  const map = timeMap(project)
  const changes = [...(project.keyChanges ?? [])].filter((change) => change.bar > 0).sort((a, b) => a.bar - b.bar)
  const starts: Omit<KeySegment, 'end'>[] = [{ id: null, bar: 0, tick: 0, key: project.key }]
  for (const change of changes) {
    // Two at one bar: the later-made stands.
    if (starts[starts.length - 1].bar === change.bar) starts.pop()
    starts.push({ id: change.id, bar: change.bar, tick: map.barStart(change.bar), key: change.key })
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
