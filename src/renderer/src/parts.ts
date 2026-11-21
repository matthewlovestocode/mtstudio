/**
 * Parts to start from, the companions of the drum patterns in drums.ts:
 * bass lines, chords, and figures for a synth or a lead. A part is written
 * against a chord, not in notes, so it comes out in the project's key and
 * moves with the chords the other tracks play; a bass line can also lock
 * to the kick of the drums it sits over.
 */
import { newId, PPQ, type MidiClip, type Note, type Project, type Track } from '@shared/model'
import { keyAt } from '@shared/keymap'
import { inKey, keyChords, type Key } from '@shared/theory'
import { timeMap, type Bar } from '@shared/timemap'
import { isDrumTrack, kitFor, seeded, SWING } from './drums'
import { barChords } from './harmony'

/**
 * A part, a sixteenth to a character, one bar (16) or two (32) long.
 *
 * A bass line or a lead is a line of notes: `1` is the chord's root, `3` its third, `5` its fifth, `8` the root an
 * octave up and `v` the fifth below; `2`, `4` and `7` are those steps of
 * the key above the root and `l` the step of the key below it. `=` holds
 * the note before it and `-` is a rest.
 *
 * Chords are a rhythm, the whole chord on each hit: `x` a hit, `X` a
 * strong one, `o` a soft one, `=` and `-` as above.
 */
export interface Part {
  name: string
  style: string
  group: string
  kind: 'bass' | 'chords' | 'lead'
  /** How chords are spread: around middle C, higher, with the seventh, or wide with the root underneath. */
  voicing?: 'mid' | 'high' | 'seventh' | 'wide'
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

const BASS: Omit<Part, 'kind'>[] = [
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

const CHORDS: Part[] = [
  { name: 'Skank', style: 'Reggae', group: 'Chords', kind: 'chords', bpm: '70–90', line: '--x---x---x---x-', voicing: 'high' },
  { name: 'Skank, double', style: 'Reggae', group: 'Chords', kind: 'chords', bpm: '70–90', line: '--xo--xo--xo--xo', voicing: 'high' },
  { name: 'Organ bubble', style: 'Reggae', group: 'Chords', kind: 'chords', bpm: '70–90', line: 'o-xoo-xoo-xoo-xo', voicing: 'mid' },
  { name: 'Ska upstroke', style: 'Reggae', group: 'Chords', kind: 'chords', bpm: '110–130', line: '--X---X---X---X-', voicing: 'high' },
  { name: 'One drop chords', style: 'Reggae', group: 'Chords', kind: 'chords', bpm: '70–85', line: '----x=------x=--', voicing: 'mid' },
  { name: 'Dub stabs', style: 'Reggae', group: 'Chords', kind: 'chords', bpm: '70–85', line: '--x-----------x-', voicing: 'high' },
  { name: 'Lovers pad', style: 'Reggae', group: 'Chords', kind: 'chords', bpm: '70–85', line: 'X===============', voicing: 'wide' },
  { name: 'Dancehall stabs', style: 'Dancehall', group: 'Chords', kind: 'chords', bpm: '90–105', line: 'x--x--x-x--x--x-', voicing: 'high' },
  { name: 'Dancehall stabs, offbeat', style: 'Dancehall', group: 'Chords', kind: 'chords', bpm: '90–105', line: '--x---x---x--x--', voicing: 'high' },
  { name: 'Dancehall stabs, sparse', style: 'Dancehall', group: 'Chords', kind: 'chords', bpm: '90–105', line: 'x-----x---------', voicing: 'mid' },
  { name: '90s stabs', style: 'Dancehall', group: 'Chords', kind: 'chords', bpm: '92–104', line: '---x--x----x--x-', voicing: 'high' },
  { name: 'Dancehall organ', style: 'Dancehall', group: 'Chords', kind: 'chords', bpm: '90–105', line: 'x=-x=-x=x=-x=-x=', voicing: 'mid' },
  { name: 'Dancehall pad', style: 'Dancehall', group: 'Chords', kind: 'chords', bpm: '90–105', line: 'X===============', voicing: 'wide' },
  { name: 'Reggaeton chords', style: 'Reggaeton', group: 'Chords', kind: 'chords', bpm: '88–100', line: 'X--x--x-X--x--x-', voicing: 'mid' },
  { name: 'Reggaeton stabs, offbeat', style: 'Reggaeton', group: 'Chords', kind: 'chords', bpm: '88–100', line: '--x---x---x---x-', voicing: 'high' },
  { name: 'Reggaeton piano', style: 'Reggaeton', group: 'Chords', kind: 'chords', bpm: '88–100', line: 'X==x==x=--x=x=--', voicing: 'seventh' },
  { name: 'Reggaeton pad', style: 'Reggaeton', group: 'Chords', kind: 'chords', bpm: '88–100', line: 'X===============', voicing: 'wide' },
  { name: 'Trap pad', style: 'Trap', group: 'Chords', kind: 'chords', bpm: '130–150', line: 'X===============', voicing: 'wide' },
  { name: 'Trap piano', style: 'Trap', group: 'Chords', kind: 'chords', bpm: '130–150', line: 'X=====x===x=----', voicing: 'seventh' },
  { name: 'Trap stabs', style: 'Trap', group: 'Chords', kind: 'chords', bpm: '130–150', line: 'X-------x-----x-', voicing: 'mid' },
  { name: 'Drill piano', style: 'Drill', group: 'Chords', kind: 'chords', bpm: '138–145', line: 'X==x====--x==x==', voicing: 'seventh' },
  { name: 'Drill pad', style: 'Drill', group: 'Chords', kind: 'chords', bpm: '138–145', line: 'X===============', voicing: 'wide' },
  { name: 'House stabs', style: 'House', group: 'Chords', kind: 'chords', bpm: '120–128', line: 'x--x--x---x--x--', voicing: 'seventh' },
  { name: 'House stabs, offbeat', style: 'House', group: 'Chords', kind: 'chords', bpm: '120–128', line: '--x---x---x---x-', voicing: 'high' },
  { name: 'House piano', style: 'House', group: 'Chords', kind: 'chords', bpm: '120–128', line: 'X--x--x--x--x-x-', voicing: 'mid' },
  { name: 'Organ stabs', style: 'House', group: 'Chords', kind: 'chords', bpm: '120–128', line: '--x-x---x-x--x--', voicing: 'mid' },
  { name: 'House pad', style: 'House', group: 'Chords', kind: 'chords', bpm: '120–128', line: 'X===============', voicing: 'wide' }
]

const LEADS: Part[] = [
  { name: 'Bell melody', style: 'Trap', group: 'Synth and melody', kind: 'lead', bpm: '130–150', line: '8=--5=--3=--5=7=8=--5=--3=1=----' },
  { name: 'Dark bells', style: 'Trap', group: 'Synth and melody', kind: 'lead', bpm: '130–150', line: '5=--3=--1=--l=--' },
  { name: 'Pluck arp', style: 'Trap', group: 'Synth and melody', kind: 'lead', bpm: '130–150', line: '1-5-8-5-3-5-8-5-' },
  { name: 'Flute riff', style: 'Trap', group: 'Synth and melody', kind: 'lead', bpm: '130–150', line: '5===--3=5=7=5===' },
  { name: 'Drill piano riff', style: 'Drill', group: 'Synth and melody', kind: 'lead', bpm: '138–145', line: '1=--5=--8=7=5=--3=--5=--2=1=----' },
  { name: 'Drill strings', style: 'Drill', group: 'Synth and melody', kind: 'lead', bpm: '138–145', line: '8=====7=5=======' },
  { name: 'Drill bells', style: 'Drill', group: 'Synth and melody', kind: 'lead', bpm: '138–145', line: '8=--7=--5=--3=5=' },
  { name: 'Dancehall riff', style: 'Dancehall', group: 'Synth and melody', kind: 'lead', bpm: '90–105', line: '5=-5=-3=5=-5=-1=' },
  { name: 'Dancehall pluck', style: 'Dancehall', group: 'Synth and melody', kind: 'lead', bpm: '90–105', line: '8=-5=-3=8=-5=-3=' },
  { name: 'Steel pan riff', style: 'Dancehall', group: 'Synth and melody', kind: 'lead', bpm: '90–105', line: '3=5=8=--5=3=1=--' },
  { name: 'Dancehall hook', style: 'Dancehall', group: 'Synth and melody', kind: 'lead', bpm: '90–105', line: '5=====3=5=7=8===5=====3=2=1=----' },
  { name: 'Reggaeton pluck', style: 'Reggaeton', group: 'Synth and melody', kind: 'lead', bpm: '88–100', line: '1=-3=-5=8=-5=-3=' },
  { name: 'Reggaeton guitar', style: 'Reggaeton', group: 'Synth and melody', kind: 'lead', bpm: '88–100', line: '1=3=5=3=8=5=3=5=' },
  { name: 'Reggaeton marimba', style: 'Reggaeton', group: 'Synth and melody', kind: 'lead', bpm: '88–100', line: '5--3--1-5--3--1-' },
  { name: 'Reggaeton hook', style: 'Reggaeton', group: 'Synth and melody', kind: 'lead', bpm: '88–100', line: '8=======7=5=3=5=' },
  { name: 'Guitar pick', style: 'Reggae', group: 'Synth and melody', kind: 'lead', bpm: '70–85', line: '----1=3=5=3=1===' },
  { name: 'Horn line', style: 'Reggae', group: 'Synth and melody', kind: 'lead', bpm: '70–85', line: '5===3=1=--------1=3=5===3=------' },
  { name: 'Melodica', style: 'Reggae', group: 'Synth and melody', kind: 'lead', bpm: '70–85', line: '8=7=5=--3=5=----' },
  { name: 'House pluck', style: 'House', group: 'Synth and melody', kind: 'lead', bpm: '120–128', line: '1--5--8-1--5--8-' },
  { name: 'House riff', style: 'House', group: 'Synth and melody', kind: 'lead', bpm: '120–128', line: '8=--7=5=--3=5=--' },
  { name: 'Arp, up', style: 'Arpeggios', group: 'Synth and melody', kind: 'lead', bpm: 'any', line: '1358135813581358' },
  { name: 'Arp, down', style: 'Arpeggios', group: 'Synth and melody', kind: 'lead', bpm: 'any', line: '8531853185318531' },
  { name: 'Arp, up and down', style: 'Arpeggios', group: 'Synth and melody', kind: 'lead', bpm: 'any', line: '1358531358531358' },
  { name: 'Arp, eighths', style: 'Arpeggios', group: 'Synth and melody', kind: 'lead', bpm: 'any', line: '1=3=5=8=5=3=1=3=' },
  { name: 'Arp, broken', style: 'Arpeggios', group: 'Synth and melody', kind: 'lead', bpm: 'any', line: '1=5=3=8=5=3=5=1=' },
  { name: 'Arp, with seventh', style: 'Arpeggios', group: 'Synth and melody', kind: 'lead', bpm: 'any', line: '1=3=5=7=8=7=5=3=' }
]

export const PARTS: Part[] = [...BASS.map((each): Part => ({ ...each, kind: 'bass' })), ...CHORDS, ...LEADS]

/** What a part is listed under within its style: bass lines by their groups, then chords, then the rest. */
export const headingOf = (part: Part): string => (part.kind === 'bass' ? `Bass · ${part.group}` : part.group)
const KINDS = ['bass', 'chords', 'lead']
const BASS_GROUPS = ['808', 'Womp', 'Modern', 'Trap dancehall', 'Tresillo', 'Roots', 'Other']
/** Parts in the order they are listed within a style. */
export const partOrder = (a: Part, b: Part): number => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || BASS_GROUPS.indexOf(a.group) - BASS_GROUPS.indexOf(b.group)

/**
 * Where the bass goes bar by bar when no other track is playing chords to
 * follow: steps of the key, from 0, four bars to a round.
 */
const MOVES: Record<string, number[]> = {
  Trap: [0, 0, 5, 6],
  Drill: [0, 0, 5, 4],
  Dancehall: [0, 0, 0, 6],
  Reggaeton: [0, 5, 2, 6],
  Reggae: [0, 0, 3, 3],
  House: [0, 5, 3, 4],
  Arpeggios: [0, 5, 2, 6]
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
/** And the lowest a lead's root is put on: the F above middle C. */
const LEAD_LOWEST = 65
const mod12 = (n: number): number => ((n % 12) + 12) % 12

/** What a bar's notes are measured from. */
interface Harmony {
  /** The root's pitch, in the bass's bottom octave. */
  root: number
  /** Semitones from the root to the chord's third and fifth, and to the seventh the key puts on top of it. */
  third: number
  fifth: number
  seventh: number
  key: Key
}

/** The pitch a character of a line stands for over a harmony. */
function pitchOf(mark: string, { root, third, fifth, key }: Harmony, floor = LOWEST): number {
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
      return root + fifth - 12 >= floor - 5 ? root + fifth - 12 : root + fifth
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
 * The notes that play a part in `clip`, made `length` ticks long.
 *
 * Each bar is played over the chord the clip already has there, or the
 * other tracks have; where there is none, over a round of the key's chords that suits the style.
 * Like the drum patterns it goes somewhere: every fourth bar ends by
 * leaning into the next, and in the second four of eight the line reaches
 * up an octave. Over drums it locks to the kick: a line marked `follow` is
 * rebuilt on the kicks, and any other has notes that fall a sixteenth from
 * a kick moved onto it. The same line always comes out the same.
 */
export function partNotes(line: Part, project: Project, track: Track, clip: MidiClip, length: number): Note[] {
  const start = clip.start
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
  // The chords the clip already holds are kept: a new rhythm for them, not new chords. Otherwise they are the other tracks'.
  const heard = barChords(project, track, { ...clip, length }, spans, (tick) => keyAt(project, tick))
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
    // A bass has its roots in its bottom octave; a lead in the octave from the F above middle C.
    const floor = line.kind === 'lead' ? LEAD_LOWEST : LOWEST
    const root = floor + mod12(tones[0] - floor)
    last = { root, third: mod12(tones[1] - tones[0]), fifth: mod12(tones[2] - tones[0]), seventh: inKey(key, tones[0] + 10) ? 10 : 11, key }
    harmony.push(last)
  }

  const late = Math.round((SWING[line.name] ?? SWING[line.style] ?? 0) * SIXTEENTH * 0.5)
  if (line.kind === 'chords') return chordNotes(line, harmony, steps, length, late, random)
  const floor = line.kind === 'lead' ? LEAD_LOWEST : LOWEST

  // ── The line, laid out and made to go somewhere.
  // Only a bass locks to the kick.
  const kicks = line.kind === 'bass' ? kicksUnder(project, start, length) : []
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
  const loud = (step: number): number => Math.min(1, (step % BAR === 0 ? 0.95 : step % 4 === 0 ? 0.86 : 0.78) * (0.95 + random() * 0.1))

  if (onKicks) {
    // A note on every kick. Now and then the last of a bar answers with the fifth or the octave.
    kicks.forEach((at, i) => {
      const bar = Math.min(bars - 1, Math.floor(at / (SIXTEENTH * BAR)))
      const next = kicks[i + 1] ?? length
      const closes = Math.floor(next / (SIXTEENTH * BAR)) > bar && bar % 2 === 1 && at % (SIXTEENTH * BAR) >= SIXTEENTH * 8
      const mark = closes ? (random() < 0.5 ? '5' : '8') : '1'
      const reach = line.follow === 'long' ? next - at : Math.min(next - at, SIXTEENTH * 2)
      placed.push({ start: at, length: Math.max(SIXTEENTH / 2, reach - 20), pitch: pitchOf(mark, harmony[bar], floor), velocity: loud(Math.round(at / SIXTEENTH)) })
    })
  } else {
    for (let step = 0; step < steps; step++) {
      const mark = marks[step]
      if (mark === '-' || mark === '=') continue
      let held = 1
      while (step + held < steps && marks[step + held] === '=') held++
      const bar = Math.min(bars - 1, Math.floor(step / BAR))
      // The lean-in is measured from the bar it leans into; at the end of the clip that is the bar it loops back to.
      const pitch = mark === '>' ? pitchOf('l', harmony[(bar + 1) % bars], floor) : pitchOf(mark, harmony[bar], floor)
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

/** Where each way of spreading a chord puts its notes: the lowest note of the octave they fall in. */
const WINDOWS: Record<NonNullable<Part['voicing']>, number> = { mid: 55, seventh: 55, wide: 55, high: 62 }

/**
 * The notes of a chord part. Each of the chord's notes goes to wherever it
 * falls within one octave, so from chord to chord the hand hardly moves.
 * Every fourth bar pushes into the next with a hit just before it, and in
 * the second four of eight the chords gain a note on top.
 */
function chordNotes(part: Part, harmony: Harmony[], steps: number, length: number, late: number, random: () => number): Note[] {
  const voicing = part.voicing ?? 'mid'
  const low = WINDOWS[voicing]
  const bars = harmony.length
  const marks = Array.from({ length: steps }, (_, step) => part.line[step % part.line.length])
  // The push: where a fourth bar ends on a rest, a soft hit on its last half-beat.
  if (bars >= 4) for (let bar = 3; bar < bars; bar += 4) if (bar * BAR + 15 < steps && marks[bar * BAR + 14] === '-' && marks[bar * BAR + 15] === '-') marks[bar * BAR + 14] = 'o'

  const notes: Note[] = []
  for (let step = 0; step < steps; step++) {
    const mark = marks[step]
    if (mark === '-' || mark === '=') continue
    let held = 1
    while (step + held < steps && marks[step + held] === '=') held++
    const bar = Math.min(bars - 1, Math.floor(step / BAR))
    // The push plays the chord that is coming.
    const pushed = mark === 'o' && part.line[step % part.line.length] === '-'
    const { root, third, fifth, seventh } = harmony[pushed ? (bar + 1) % bars : bar]
    const within = (semitones: number): number => low + mod12(root + semitones - low)
    const pitches = [within(0), within(third), within(fifth)]
    if (voicing === 'seventh') pitches.push(within(seventh))
    if (voicing === 'wide') pitches.push(within(0) - 12)
    if (Math.floor(bar / 4) % 2 === 1) pitches.push(within(0) + 12)
    const level = (mark === 'X' ? 0.92 : mark === 'o' ? 0.5 : 0.78) * (0.95 + random() * 0.1)
    const start = step * SIXTEENTH + (step % 2 === 1 ? late : 0)
    // A hit that is not held is short: a stab, not a chord left ringing.
    const lasts = held > 1 ? held * SIXTEENTH - 20 : Math.round(SIXTEENTH * 0.8)
    const top = Math.max(...pitches)
    for (const pitch of new Set(pitches)) notes.push({ id: newId(), pitch, start, length: Math.min(lasts, length - start), velocity: Math.min(1, pitch === top ? level * 1.06 : level) })
  }
  return notes.filter((note) => note.start < length && note.length > 0)
}
