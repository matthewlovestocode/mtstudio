/**
 * Bass lines to start from, the companions of the drum patterns in
 * drums.ts. A line is written against a chord, not in notes, so it comes
 * out in the project's key, moves with the chords the other tracks play,
 * and can lock to the kick of the drums it sits over.
 */
import { newId, PPQ, type MidiClip, type Note, type Project, type Track } from '@shared/model'
import { keyAt } from '@shared/keymap'
import { inKey, keyChords, type Key } from '@shared/theory'
import { timeMap, type Bar } from '@shared/timemap'
import { isDrumTrack, kitFor, seeded, SWING } from './drums'
import { barChords } from './harmony'

/**
 * A bass line, a sixteenth to a character, one bar (16) or two (32) long.
 * `1` is the chord's root, `3` its third, `5` its fifth, `8` the root an
 * octave up and `v` the fifth below; `2`, `4` and `7` are those steps of
 * the key above the root and `l` the step of the key below it. `=` holds
 * the note before it and `-` is a rest.
 */
export interface BassLine {
  name: string
  style: string
  group: string
  /** A tempo it sits well at, as a hint. */
  bpm: string
  line: string
  /**
   * Where there are drums under the clip the line is not played as
   * written: a note is put on every kick, held to the next kick (`long`)
   * or kept short. Without drums the written line stands in.
   */
  follow?: 'long' | 'short'
}

export const BASS_LINES: BassLine[] = [
  { name: '808, long', style: 'Trap', group: '808', bpm: '130–150', line: '1===============1=========5=====' },
  { name: '808, on the kick', style: 'Trap', group: '808', bpm: '130–150', line: '1=====1===1==1==', follow: 'long' },
  { name: '808, bouncy', style: 'Trap', group: '808', bpm: '130–150', line: '1==1==1=--1=1=--' },
  { name: '808, octave jump', style: 'Trap', group: '808', bpm: '130–150', line: '1=====1===8=1===1=====1=----5=7=' },
  { name: '808, sparse', style: 'Trap', group: '808', bpm: '130–150', line: '1=======--------1=====----1=====' },
  { name: '808, dark', style: 'Trap', group: '808', bpm: '130–150', line: '1=====1=--2=1===' },
  { name: '808, melodic', style: 'Trap', group: '808', bpm: '130–150', line: '1=====5=--7=8===1=====3=--5=3=1=' },
  { name: '808, rolling', style: 'Trap', group: '808', bpm: '130–150', line: '1=1=1=--1=1=--1=' },
  { name: '808, pickup', style: 'Trap', group: '808', bpm: '130–150', line: '1=======----l=1=' },
  { name: 'Drill 808', style: 'Drill', group: '808', bpm: '138–145', line: '1==1====--1==5==1==1==--7==8==l=' },
  { name: 'Drill 808, on the kick', style: 'Drill', group: '808', bpm: '138–145', line: '1==1=====1==1===', follow: 'long' },
  { name: 'Drill 808, sliding', style: 'Drill', group: '808', bpm: '138–145', line: '1=====8=7=5=====1=====5=7=8=7=5=' },
  { name: 'Drill 808, dark', style: 'Drill', group: '808', bpm: '138–145', line: '1==1==--2==1==--' },
  { name: 'Drill 808, sparse', style: 'Drill', group: '808', bpm: '138–145', line: '1=======--1=====' },
  { name: 'Drill 808, bouncy', style: 'Drill', group: '808', bpm: '138–145', line: '1==1==1=1==1==5=' },
  { name: 'Drill 808, counter', style: 'Drill', group: '808', bpm: '138–145', line: '1==--1==--5==1==1==--1==--7==5==' },
  { name: 'Womp', style: 'Dancehall', group: 'Womp', bpm: '92–104', line: '1=1=----1=1=----' },
  { name: 'Womp, answer', style: 'Dancehall', group: 'Womp', bpm: '92–104', line: '1=1=--v=1=1=--v=' },
  { name: 'Womp, slow', style: 'Dancehall', group: 'Womp', bpm: '85–95', line: '1=1=======------' },
  { name: 'Womp, on the kick', style: 'Dancehall', group: 'Womp', bpm: '92–104', line: '1=1=--1=1=1=--1=', follow: 'short' },
  { name: 'Womp, octave', style: 'Dancehall', group: 'Womp', bpm: '92–104', line: '1=1=--8=1=1=--8=' },
  { name: 'Womp, heavy', style: 'Dancehall', group: 'Womp', bpm: '92–104', line: '1=11--1=1=11--5=' },
  { name: 'Womp, long', style: 'Dancehall', group: 'Womp', bpm: '92–104', line: '1=1=========--1=' },
  { name: '90s hardcore bass', style: 'Dancehall', group: 'Womp', bpm: '92–104', line: '1==1==1=1==1==5=' },
  { name: '90s hardcore bass, walking', style: 'Dancehall', group: 'Womp', bpm: '92–104', line: '1==1==3=5==5==3=' },
  { name: 'Dancehall bass', style: 'Dancehall', group: 'Modern', bpm: '90–105', line: '1==---1=1==---5=' },
  { name: 'Dancehall bass, melodic', style: 'Dancehall', group: 'Modern', bpm: '90–105', line: '1==3==5=1==7==5=' },
  { name: 'Dancehall bass, sub', style: 'Dancehall', group: 'Modern', bpm: '90–105', line: '1===========--1=' },
  { name: 'Dancehall bass, bounce', style: 'Dancehall', group: 'Modern', bpm: '90–105', line: '1==1--1=1==1--1=' },
  { name: 'Dancehall bass, on the kick', style: 'Dancehall', group: 'Modern', bpm: '90–105', line: '1=======1==1====', follow: 'long' },
  { name: 'Dancehall bass, two notes', style: 'Dancehall', group: 'Modern', bpm: '90–105', line: '1=====1=--------5=====5=--------' },
  { name: 'Trap dancehall 808', style: 'Dancehall', group: 'Trap dancehall', bpm: '95–105', line: '1=====1=1=======1=====1=1==5==7=' },
  { name: 'Trap dancehall 808, sparse', style: 'Dancehall', group: 'Trap dancehall', bpm: '95–105', line: '1===============1=======--1=====' },
  { name: 'Reggaeton bass', style: 'Reggaeton', group: 'Tresillo', bpm: '88–100', line: '1==1==1=1==1==1=' },
  { name: 'Reggaeton bass, sub', style: 'Reggaeton', group: 'Tresillo', bpm: '88–100', line: '1=====1=1=====1=' },
  { name: 'Reggaeton bass, octave', style: 'Reggaeton', group: 'Tresillo', bpm: '88–100', line: '1==8==1=1==8==1=' },
  { name: 'Reggaeton bass, fifth', style: 'Reggaeton', group: 'Tresillo', bpm: '88–100', line: '1==1==5=1==1==5=' },
  { name: 'Reggaeton bass, melodic', style: 'Reggaeton', group: 'Tresillo', bpm: '88–100', line: '1==3==5=8==5==3=' },
  { name: 'Reggaeton bass, perreo', style: 'Reggaeton', group: 'Tresillo', bpm: '90–100', line: '1=-1=-1=1=-1=-1=' },
  { name: 'Reggaeton bass, long', style: 'Reggaeton', group: 'Other', bpm: '88–100', line: '1===========1===' },
  { name: 'Reggaeton bass, sparse', style: 'Reggaeton', group: 'Other', bpm: '88–100', line: '1=======--1=----' },
  { name: 'Reggaeton bass, on the kick', style: 'Reggaeton', group: 'Other', bpm: '88–100', line: '1===1===1===1===', follow: 'short' },
  { name: 'Reggaeton bass, offbeat', style: 'Reggaeton', group: 'Other', bpm: '88–100', line: '--1=--1=--1=--1=' },
  { name: 'One drop bass', style: 'Reggae', group: 'Roots', bpm: '70–85', line: '----1=3=5=3=1===' },
  { name: 'Roots bass', style: 'Reggae', group: 'Roots', bpm: '70–85', line: '1==-1=5=--5=3=1=' },
  { name: 'Rockers bass', style: 'Reggae', group: 'Roots', bpm: '75–90', line: '1=1=5=5=3=3=1=l=' },
  { name: 'Steppers bass', style: 'Reggae', group: 'Roots', bpm: '75–90', line: '1=--1=--5=--3=--' },
  { name: 'Dub bass', style: 'Reggae', group: 'Roots', bpm: '70–85', line: '1=====--5=3=1===' },
  { name: 'Roots bass, two bars', style: 'Reggae', group: 'Roots', bpm: '70–85', line: '1==-1=5=--3=5=--1==-1=3=--5=l===' },
  { name: 'Lovers bass', style: 'Reggae', group: 'Other', bpm: '70–85', line: '1===--5=3===--1=' },
  { name: 'Ska bass', style: 'Reggae', group: 'Other', bpm: '110–130', line: '1=3=5=3=1=3=5=7=' },
  { name: 'Reggae bass, on the kick', style: 'Reggae', group: 'Other', bpm: '70–85', line: '--------1=======', follow: 'long' }
]

/** The order of the groups within each style. */
export const BASS_GROUPS: Record<string, string[]> = {
  Trap: ['808'],
  Drill: ['808'],
  Dancehall: ['Womp', 'Modern', 'Trap dancehall'],
  Reggaeton: ['Tresillo', 'Other'],
  Reggae: ['Roots', 'Other']
}

/**
 * Where the bass goes bar by bar when no other track is playing chords to
 * follow: steps of the key, from 0, four bars to a round.
 */
const MOVES: Record<string, number[]> = {
  Trap: [0, 0, 5, 6],
  Drill: [0, 0, 5, 4],
  Dancehall: [0, 0, 0, 6],
  Reggaeton: [0, 5, 2, 6],
  Reggae: [0, 0, 3, 3]
}

/**
 * How long a clip should be for a pattern to run its course: eight bars, or
 * as many whole bars as the next clip on the track leaves room for; never
 * shorter than it is.
 */
export function roomFor(project: Project, track: Track, clip: MidiClip): number {
  const bar = timeMap(project).barAt(clip.start).length
  const next = Math.min(...track.clips.filter((each) => each.id !== clip.id && each.start >= clip.start + clip.length).map((each) => each.start), Infinity)
  return Math.max(clip.length, Math.min(bar * 8, Math.floor((next - clip.start) / bar) * bar))
}

const SIXTEENTH = PPQ / 4
const BAR = 16
/** The lowest note a root is put on: E1, the bottom string of a bass. Roots fall in the octave from there. */
const LOWEST = 28
const mod12 = (n: number): number => ((n % 12) + 12) % 12

/** What a bar's notes are measured from. */
interface Harmony {
  /** The root's pitch, in the bass's bottom octave. */
  root: number
  /** Semitones from the root to the chord's third and fifth. */
  third: number
  fifth: number
  key: Key
}

/** The pitch a character of a line stands for over a harmony. */
function pitchOf(mark: string, { root, third, fifth, key }: Harmony): number {
  /** The first of some distances above the root that is in the key. */
  const step = (...semitones: number[]): number => root + (semitones.find((each) => inKey(key, root + each)) ?? semitones[0])
  switch (mark) {
    case '3':
      return root + third
    case '5':
      return root + fifth
    case '8':
      return root + 12
    case 'v':
      // Below the root, unless that is lower than a bass goes.
      return root + fifth - 12 >= LOWEST - 5 ? root + fifth - 12 : root + fifth
    case '2':
      return step(2, 1)
    case '4':
      return step(5, 6)
    case '7':
      return step(10, 11)
    case 'l':
      return step(-2, -1)
    default:
      return root
  }
}

/** When the kicks of the drums under a stretch of the timeline fall, in ticks from its start. */
function kicksUnder(project: Project, start: number, length: number): number[] {
  const found: number[] = []
  for (const track of project.tracks) {
    if (track.kind !== 'midi' || !isDrumTrack(track)) continue
    const kick = kitFor(track).roles.kick
    for (const clip of track.clips) {
      if (clip.kind !== 'midi') continue
      for (const note of clip.notes) {
        const at = clip.start + note.start - start
        // General MIDI's second kick counts too.
        if ((note.pitch === kick || note.pitch === 35) && note.start >= 0 && note.start < clip.length && at >= 0 && at < length) found.push(at)
      }
    }
  }
  found.sort((a, b) => a - b)
  // The hits of a roll are one kick.
  return found.filter((at, i) => i === 0 || at - found[i - 1] > SIXTEENTH / 2)
}

/**
 * The notes that play a bass line in a clip at `start` for `length` ticks.
 *
 * Each bar is played over the chord the other tracks have there; where
 * they have none, over a round of the key's chords that suits the style.
 * Like the drum patterns it goes somewhere: every fourth bar ends by
 * leaning into the next, and in the second four of eight the line reaches
 * up an octave. Over drums it locks to the kick: a line marked `follow` is
 * rebuilt on the kicks, and any other has notes that fall a sixteenth from
 * a kick moved onto it. The same line always comes out the same.
 */
export function bassNotes(line: BassLine, project: Project, track: Track, start: number, length: number): Note[] {
  const map = timeMap(project)
  const steps = Math.ceil(length / SIXTEENTH)
  const bars = Math.max(1, Math.ceil(steps / BAR))
  const random = seeded(line.name)

  // ── The harmony of each bar.
  const spans: Bar[] = []
  for (let tick = start; tick < start + length; ) {
    const bar = map.barAt(tick)
    spans.push(bar)
    tick = bar.start + bar.length
  }
  const silent = { id: '', kind: 'midi', name: '', start, length, notes: [] } as MidiClip
  const heard = barChords(project, track, silent, spans, (tick) => keyAt(project, tick))
  const following = heard.some(Boolean)
  /** How many bars the chords run for before they stop. */
  const round = heard.reduce((end, chord, bar) => (chord ? bar + 1 : end), 0)
  const moves = MOVES[line.style] ?? [0]
  let last: Harmony | null = null
  const harmony: Harmony[] = []
  for (let bar = 0; bar < bars; bar++) {
    const key = keyAt(project, spans[Math.min(bar, spans.length - 1)]?.start ?? start) ?? { root: 0, scale: 'minor' as const }
    const chord = heard[bar]
    let tones: number[] | null = chord ? chord.tones : null
    // No chord in this bar. Past the end of the chords they come round again, as they will if their clip is looped or copied
    // along; in a gap among them the one before carries on; with no chords anywhere the style has a round of its own.
    if (!tones && following && bar >= round && harmony.length) {
      harmony.push(harmony[bar % round])
      continue
    }
    if (!tones && following && last) {
      harmony.push(last)
      continue
    }
    if (!tones) tones = keyChords(key)[moves[bar % moves.length] % 7].tones
    const root = LOWEST + mod12(tones[0] - LOWEST)
    last = { root, third: mod12(tones[1] - tones[0]), fifth: mod12(tones[2] - tones[0]), key }
    harmony.push(last)
  }

  // ── The line, laid out and made to go somewhere.
  const kicks = kicksUnder(project, start, length)
  const marks = Array.from({ length: steps }, (_, step) => line.line[step % line.line.length])
  const onKicks = line.follow && kicks.length >= 2
  if (!onKicks && bars >= 4) {
    for (let bar = 0; bar < bars; bar++) {
      const at = bar * BAR
      // The second four bars reach up: the last root of every other bar goes up an octave.
      if (Math.floor(bar / 4) % 2 === 1 && bar % 2 === 1) {
        for (let step = at + BAR - 1; step >= at + 8; step--) {
          if (marks[step] !== '1') continue
          marks[step] = '8'
          break
        }
      }
      // Every fourth bar leans into the next: `>` is the step of the key under the root that is coming.
      if (bar % 4 === 3 && at + BAR <= steps) {
        marks[at + 14] = '>'
        marks[at + 15] = '='
      }
    }
  }

  interface Placed {
    start: number
    length: number
    pitch: number
    velocity: number
  }
  let placed: Placed[] = []
  const late = Math.round((SWING[line.name] ?? SWING[line.style] ?? 0) * SIXTEENTH * 0.5)
  const loud = (step: number): number => Math.min(1, (step % BAR === 0 ? 0.95 : step % 4 === 0 ? 0.86 : 0.78) * (0.95 + random() * 0.1))

  if (onKicks) {
    // A note on every kick. Now and then the last of a bar answers with the fifth or the octave.
    kicks.forEach((at, i) => {
      const bar = Math.min(bars - 1, Math.floor(at / (SIXTEENTH * BAR)))
      const next = kicks[i + 1] ?? length
      const closes = Math.floor(next / (SIXTEENTH * BAR)) > bar && bar % 2 === 1 && at % (SIXTEENTH * BAR) >= SIXTEENTH * 8
      const mark = closes ? (random() < 0.5 ? '5' : '8') : '1'
      const reach = line.follow === 'long' ? next - at : Math.min(next - at, SIXTEENTH * 2)
      placed.push({ start: at, length: Math.max(SIXTEENTH / 2, reach - 20), pitch: pitchOf(mark, harmony[bar]), velocity: loud(Math.round(at / SIXTEENTH)) })
    })
  } else {
    for (let step = 0; step < steps; step++) {
      const mark = marks[step]
      if (mark === '-' || mark === '=') continue
      let held = 1
      while (step + held < steps && marks[step + held] === '=') held++
      const bar = Math.min(bars - 1, Math.floor(step / BAR))
      // The lean-in is measured from the bar it leans into; at the end of the clip that is the bar it loops back to.
      const pitch = mark === '>' ? pitchOf('l', harmony[(bar + 1) % bars]) : pitchOf(mark, harmony[bar])
      placed.push({ start: step * SIXTEENTH + (step % 2 === 1 ? late : 0), length: held * SIXTEENTH - 20, pitch, velocity: loud(step) })
    }
    // Over drums, a note a sixteenth away from a kick that has no note of its own is moved onto it.
    if (kicks.length) {
      const taken = new Set(placed.map((note) => kicks.find((kick) => Math.abs(kick - note.start) <= 40)).filter((kick) => kick !== undefined))
      placed = placed.map((note) => {
        if (kicks.some((kick) => Math.abs(kick - note.start) <= 40)) return note
        const near = kicks.find((kick) => Math.abs(kick - note.start) <= SIXTEENTH + 40 && !taken.has(kick))
        if (near === undefined) return note
        taken.add(near)
        return { ...note, start: near, length: Math.max(SIXTEENTH / 2, note.length + note.start - near) }
      })
    }
  }

  // One note at a time: a note stops where the next begins.
  placed.sort((a, b) => a.start - b.start)
  return placed
    .filter((note, i) => note.start < length && (i === 0 || note.start > placed[i - 1].start))
    .map((note, i, all) => ({ id: newId(), pitch: note.pitch, start: note.start, length: Math.max(30, Math.min(note.length, (all[i + 1]?.start ?? length) - note.start - 10)), velocity: note.velocity }))
}
