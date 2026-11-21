/**
 * What chord is sounding in each bar of a clip, worked out from the notes:
 * the clip's own, or, where it has too few to make a chord (a bass line, a
 * melody), those of the other tracks playing at the same time.
 */
import type { MidiClip, Project, Track } from '@shared/model'
import { keyChords, nameChord, type Key, type NamedChord } from '@shared/theory'
import type { Bar } from '@shared/timemap'
import { isDrumTrack } from './drums'

export interface BarChord extends NamedChord {
  /** Read from the other tracks, not from this clip: a guide to play to, not what the clip itself holds. */
  borrowed: boolean
  /** Its place in the key ("vi"), if it is one of the key's chords. */
  numeral: string | null
  /** The step of the scale it stands on, likewise. */
  degree: number | null
}

/** How much of each pitch class sounds between two ticks, and the lowest note there. */
function heardBetween(notes: { pitch: number; start: number; length: number }[], from: number, to: number): { heard: number[]; lowest: number | null; classes: number } {
  const heard = new Array<number>(12).fill(0)
  let lowest: number | null = null
  for (const note of notes) {
    const overlap = Math.min(to, note.start + note.length) - Math.max(from, note.start)
    if (overlap <= 0) continue
    heard[note.pitch % 12] += overlap
    if (lowest === null || note.pitch < lowest) lowest = note.pitch
  }
  return { heard, lowest: lowest === null ? null : lowest % 12, classes: heard.filter((amount) => amount > 0).length }
}

/** The most notes sounding at once between two ticks: three or more is a chord being played, fewer is a line. */
function mostAtOnce(notes: { start: number; length: number }[], from: number, to: number): number {
  const edges = notes
    .filter((note) => note.start < to && note.start + note.length > from)
    .flatMap((note) => [
      [note.start, 1],
      [note.start + note.length, -1]
    ])
    // A note ending where another begins is one voice, not two.
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
  let now = 0
  let most = 0
  for (const [, change] of edges) most = Math.max(most, (now += change))
  return most
}

/** The chord of each bar the clip covers (null where there is none to name), in the order of `bars`. */
export function barChords(project: Project, track: Track, clip: MidiClip, bars: Bar[], keyAtTick: (tick: number) => Key | null): (BarChord | null)[] {
  // Every other pitched track's notes, placed on the timeline.
  const others = project.tracks
    .filter((each) => each.id !== track.id && each.kind === 'midi' && !isDrumTrack(each))
    .flatMap((each) => each.clips.flatMap((other) => (other.kind === 'midi' ? other.notes.filter((n) => n.start >= 0 && n.start < other.length).map((n) => ({ ...n, start: other.start + n.start })) : [])))
  const own = clip.notes.filter((n) => n.start >= 0 && n.start < clip.length).map((n) => ({ ...n, start: clip.start + n.start }))
  return bars.map((bar) => {
    // The key may change from bar to bar.
    const key = keyAtTick(Math.max(bar.start, clip.start))
    const inKey = key ? keyChords(key) : []
    const mine = heardBetween(own, bar.start, bar.start + bar.length)
    // A melody or a bass line passes through enough notes to spell a chord without playing one; only notes held together count as the clip's own.
    const borrowed = mine.classes < 3 || mostAtOnce(own, bar.start, bar.start + bar.length) < 3
    const from = borrowed ? heardBetween(others, bar.start, bar.start + bar.length) : mine
    const chord = nameChord(from.heard, from.lowest, key)
    if (!chord) return null
    // One of the key's chords if it has the same three notes.
    const match = inKey.find((each) => each.root === chord.root && each.tones.every((tone) => chord.tones.includes(tone)))
    return { ...chord, borrowed, numeral: match?.numeral ?? null, degree: match?.degree ?? null }
  })
}
