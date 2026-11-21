/**
 * What the step sequencer knows about drums: which note is which sound in a
 * kit, a set of rhythms to start from, and ways to vary one. Everything here
 * works in notes of a MIDI clip; the sequencer is a way of writing them.
 */
import { DRUM_NAMES, newId, PPQ, type MidiClip, type Note, type Track } from '@shared/model'
import { DRUM_BANK } from './soundfont'

/** The parts of a kit a rhythm is written for. */
export type Role = 'kick' | 'snare' | 'clap' | 'rim' | 'hat' | 'open' | 'tomLow' | 'tomHigh' | 'crash' | 'ride'

export interface Kit {
  /** The note each part is on; a kit need not have every part. */
  roles: Partial<Record<Role, number>>
  /** Every sound the kit has a name for, by note. */
  names: Record<number, string>
  /** The rows the sequencer starts with, top to bottom: cymbals above, the kick at the foot. */
  rows: number[]
}

/** General MIDI's percussion map, which SoundFont kits and most sampled kits follow. */
const GM_NAMES: Record<number, string> = {
  35: 'Kick 2', 36: 'Kick', 37: 'Rim', 38: 'Snare', 39: 'Clap', 40: 'Snare 2', 41: 'Floor tom', 42: 'Hat', 43: 'Floor tom 2', 44: 'Pedal hat',
  45: 'Low tom', 46: 'Open hat', 47: 'Mid tom', 48: 'Mid tom 2', 49: 'Crash', 50: 'High tom', 51: 'Ride', 52: 'China', 53: 'Ride bell', 54: 'Tambourine',
  55: 'Splash', 56: 'Cowbell', 57: 'Crash 2', 59: 'Ride 2', 60: 'Bongo high', 61: 'Bongo low', 62: 'Conga mute', 63: 'Conga high', 64: 'Conga low',
  65: 'Timbale high', 66: 'Timbale low', 67: 'Agogo high', 68: 'Agogo low', 69: 'Cabasa', 70: 'Maracas', 75: 'Claves', 76: 'Wood block high',
  77: 'Wood block low', 80: 'Triangle mute', 81: 'Triangle'
}

const GM_KIT: Kit = {
  roles: { kick: 36, snare: 38, clap: 39, rim: 37, hat: 42, open: 46, tomLow: 45, tomHigh: 50, crash: 49, ride: 51 },
  names: GM_NAMES,
  rows: [49, 51, 46, 42, 39, 38, 50, 45, 36]
}

/** The engine's own drum machine has twelve sounds, one to each note name, in the octave from C2. */
const BUILT_IN_KIT: Kit = {
  roles: { kick: 36, snare: 38, clap: 39, rim: 37, hat: 42, open: 46, tomLow: 41, tomHigh: 45 },
  names: Object.fromEntries(DRUM_NAMES.map((name, i) => [36 + i, name])),
  rows: [46, 42, 39, 38, 37, 45, 41, 36]
}

export function kitFor(track: Track): Kit {
  return (track.instrument ?? 'synth') === 'drums' ? BUILT_IN_KIT : GM_KIT
}

/** Whether a track looks like drums, and so opens in the step sequencer: by its instrument where that says, otherwise by its name. */
export function isDrumTrack(track: Track): boolean {
  const instrument = track.instrument ?? 'synth'
  if (instrument === 'drums') return true
  if (instrument === 'soundfont') return track.soundfont?.bank === DRUM_BANK
  const named = `${track.name} ${track.sfz?.name ?? ''} ${track.sfz?.pack ?? ''} ${track.pluginPatch ?? ''}`
  return /drum|kit\b|beat|perc|808|909/i.test(named)
}

// ── Notes in steps ───────────────────────────────────────────────────────

/** The grids on offer: how many steps a beat is cut into. */
export const DIVISIONS: [number, string][] = [
  [4, '1/16'],
  [8, '1/32'],
  [3, '1/8T'],
  [6, '1/16T']
]

export const ACCENT = 1
export const NORMAL = 0.8
export const GHOST = 0.4

/** One hit, or a roll of `count` evenly through the step, getting louder towards `velocity`. */
export function hits(pitch: number, start: number, stepTicks: number, velocity: number, count = 1): Note[] {
  const gap = stepTicks / count
  return Array.from({ length: count }, (_, i) => ({
    id: newId(),
    pitch,
    start: Math.round(start + i * gap),
    length: Math.max(1, Math.round(gap)),
    // A roll swells: its first hit at about two thirds of its last.
    velocity: count === 1 ? velocity : velocity * (0.65 + (0.35 * i) / (count - 1))
  }))
}

// ── Rhythms to start from ────────────────────────────────────────────────

/**
 * A rhythm, a part to a line, in sixteenth notes: `x` a hit, `X` an accent,
 * `o` a ghost note, `2` `3` `4` a roll of that many, `-` a rest. Lines are
 * one bar (16) or two (32) long and are repeated to fill the clip.
 */
export interface Pattern {
  name: string
  /** Where it is at home, for the list and the search. */
  style: string
  /** A tempo it sits well at, as a hint; nothing sets it. */
  bpm: string
  parts: Partial<Record<Role, string>>
}

export const PATTERNS: Pattern[] = [
  {
    name: 'Trap',
    style: 'Hip hop',
    bpm: '130–150',
    parts: {
      hat: 'x-x-x-x-x-x-3-x-x-x-x-4-x-x-x-33',
      open: '--------------------------x-----',
      clap: '--------X---------------X-------',
      kick: 'X-----x---x-------x---x----x----'
    }
  },
  {
    name: 'Trap, sparse',
    style: 'Hip hop',
    bpm: '130–150',
    parts: {
      hat: 'x---x---x---x-2-x---x---x-3-x---',
      clap: '--------X---------------X-------',
      kick: 'X---------x-----X------x--x-----'
    }
  },
  {
    name: 'Drill',
    style: 'Hip hop',
    bpm: '138–145',
    parts: {
      hat: 'x--x--x-x--x--x-x--x--x-x--x-3x-',
      snare: '--------X-----------------X-----',
      kick: 'X--x------x-----X--x--x-----x---'
    }
  },
  {
    name: 'Boom bap',
    style: 'Hip hop',
    bpm: '85–95',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X--o----X---',
      kick: 'X------x-xx-----'
    }
  },
  {
    name: 'Lo-fi',
    style: 'Hip hop',
    bpm: '70–85',
    parts: {
      hat: 'x-o-x-o-x-o-x-ox',
      rim: '----X-------X---',
      kick: 'X-----x--x------'
    }
  },
  {
    name: 'Four on the floor',
    style: 'House',
    bpm: '120–128',
    parts: {
      open: '--x---x---x---x-',
      hat: 'o-o-o-o-o-o-o-o-',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Disco',
    style: 'House',
    bpm: '110–120',
    parts: {
      open: '--x---x---x---x-',
      hat: 'xox-xox-xox-xox-',
      snare: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Two-step',
    style: 'Garage',
    bpm: '128–135',
    parts: {
      hat: '-xox-xox-xox-xox',
      clap: '----X-------X---',
      kick: 'X---------x-----'
    }
  },
  {
    name: 'Rock',
    style: 'Rock',
    bpm: '100–130',
    parts: {
      crash: 'X---------------',
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X---',
      kick: 'X-------x-x-----'
    }
  },
  {
    name: 'Half-time',
    style: 'Rock',
    bpm: '70–90',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '--------X-------',
      kick: 'X---------x-----'
    }
  },
  {
    name: 'Funk',
    style: 'Funk',
    bpm: '95–110',
    parts: {
      hat: 'xxxxxxxxxxxxxxxx',
      snare: '----X--o-o--X--o',
      kick: 'X--x--x---x--x--'
    }
  },
  {
    name: 'Dembow',
    style: 'Reggaeton',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Dembow, bare',
    style: 'Reggaeton',
    bpm: '88–100',
    parts: {
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Perreo',
    style: 'Reggaeton',
    bpm: '90–100',
    parts: {
      open: '--------------x-',
      hat: 'xoxoxoxoxoxoxoxo',
      clap: '---X--X----X--X-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, soft',
    style: 'Reggaeton',
    bpm: '80–95',
    parts: {
      hat: 'o-o-o-o-o-o-o-o-',
      rim: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, with a fill',
    style: 'Reggaeton',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x----x--x----x-234',
      kick: 'X---X---X---X---X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, timbales',
    style: 'Reggaeton',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      tomHigh: '-----------------------------xx-',
      tomLow: '-------------------------------x',
      snare: '---x--x----x--x----x--x----x--x-',
      kick: 'X---X---X---X---X---X---X---X---'
    }
  },
  {
    name: 'Moombahton',
    style: 'Reggaeton',
    bpm: '100–112',
    parts: {
      open: '--x---x---x---x-',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Dancehall',
    style: 'Dancehall',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, bounce',
    style: 'Dancehall',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '------X-------X-',
      kick: 'X--x----X--x----'
    }
  },
  {
    name: 'Dancehall, claps',
    style: 'Dancehall',
    bpm: '95–110',
    parts: {
      clap: 'x--x--x-x--x--x-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, digital',
    style: 'Dancehall',
    bpm: '85–100',
    parts: {
      hat: 'xoxoxoxoxoxoxoxo',
      snare: '---x--x----x--x-',
      kick: 'X-----x-X-----x-'
    }
  },
  {
    name: 'Dancehall, with a fill',
    style: 'Dancehall',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x----x--x----x2-3-',
      kick: 'X-------X-------X-------X-----x-'
    }
  },
  {
    name: 'One drop',
    style: 'Reggae',
    bpm: '130–160',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      rim: '--------X-------',
      kick: '--------X-------'
    }
  },
  {
    name: 'One drop, busier',
    style: 'Reggae',
    bpm: '130–160',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      tomHigh: '----------------------------x-x-',
      rim: '--------X-----o---------X-------',
      kick: '--------X---------------X-------'
    }
  },
  {
    name: 'Rockers',
    style: 'Reggae',
    bpm: '130–160',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '--------X-------',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Steppers',
    style: 'Reggae',
    bpm: '130–160',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '--------X-------',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Steppers, dub',
    style: 'Reggae',
    bpm: '130–150',
    parts: {
      open: '--x---x---x---x-',
      rim: '--------X-------',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Drum and bass',
    style: 'Breakbeat',
    bpm: '165–175',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X---',
      kick: 'X---------x-----'
    }
  },
  {
    name: 'Breakbeat',
    style: 'Breakbeat',
    bpm: '125–140',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X--o-o--X---',
      kick: 'X-x-------x--x--'
    }
  }
]

const SIXTEENTH = PPQ / 4

/** The notes that play a pattern on a kit for `length` ticks. Parts the kit lacks fall back where they can (a clap to the snare) or are left out. */
export function patternNotes(pattern: Pattern, kit: Kit, length: number): Note[] {
  const fallback: Partial<Record<Role, Role>> = { clap: 'snare', rim: 'snare', crash: 'open', ride: 'hat', open: 'hat' }
  const notes: Note[] = []
  for (const [role, line] of Object.entries(pattern.parts) as [Role, string][]) {
    const pitch = kit.roles[role] ?? kit.roles[fallback[role] ?? role]
    if (pitch === undefined) continue
    for (let step = 0; step * SIXTEENTH < length; step++) {
      const mark = line[step % line.length]
      if (mark === '-') continue
      const start = step * SIXTEENTH
      if (mark >= '2' && mark <= '4') notes.push(...hits(pitch, start, SIXTEENTH, NORMAL, Number(mark)))
      else notes.push(...hits(pitch, start, SIXTEENTH, mark === 'X' ? ACCENT : mark === 'o' ? GHOST : NORMAL))
    }
  }
  return notes.filter((note) => note.start < length)
}

// ── Ways to change a rhythm ──────────────────────────────────────────────

const pick = <T>(from: T[]): T | undefined => from[Math.floor(Math.random() * from.length)]
const stepOf = (note: Note): number => Math.floor(note.start / SIXTEENTH)

/**
 * A relative of the rhythm: a couple of small changes of the kind a drummer
 * makes the second time round. A kick moves or is added, a quiet snare
 * slips in, a hat becomes a roll or drops out. Hits on the bar's main beats
 * are left where they are, so it stays the same rhythm.
 */
export function vary(clip: MidiClip, kit: Kit): Note[] {
  let notes = [...clip.notes]
  const steps = Math.max(1, Math.floor(clip.length / SIXTEENTH))
  const at = (pitch: number | undefined, step: number): Note[] => notes.filter((n) => n.pitch === pitch && stepOf(n) === step)
  const free = (pitch: number | undefined): number[] => Array.from({ length: steps }, (_, i) => i).filter((i) => i % 4 !== 0 && !at(pitch, i).length)

  const moves: (() => void)[] = [
    () => {
      // A kick that is not on a beat moves a step either way.
      const kick = pick(notes.filter((n) => n.pitch === kit.roles.kick && stepOf(n) % 4 !== 0))
      if (!kick) return
      const to = stepOf(kick) + (Math.random() < 0.5 ? -1 : 1)
      if (to > 0 && to < steps && to % 4 !== 0 && !at(kick.pitch, to).length) notes = notes.map((n) => (n === kick ? { ...n, id: newId(), start: to * SIXTEENTH } : n))
    },
    () => {
      const step = pick(free(kit.roles.kick))
      if (step !== undefined && kit.roles.kick !== undefined) notes.push(...hits(kit.roles.kick, step * SIXTEENTH, SIXTEENTH, NORMAL))
    },
    () => {
      const step = pick(free(kit.roles.snare))
      if (step !== undefined && kit.roles.snare !== undefined) notes.push(...hits(kit.roles.snare, step * SIXTEENTH, SIXTEENTH, GHOST))
    },
    () => {
      // A single hat becomes a roll.
      const hat = pick(notes.filter((n) => n.pitch === kit.roles.hat && at(n.pitch, stepOf(n)).length === 1))
      if (!hat) return
      const step = stepOf(hat)
      notes = [...notes.filter((n) => n !== hat), ...hits(hat.pitch, step * SIXTEENTH, SIXTEENTH, NORMAL, Math.random() < 0.5 ? 2 : 3)]
    },
    () => {
      const hat = pick(notes.filter((n) => n.pitch === kit.roles.hat && stepOf(n) % 4 !== 0))
      if (hat) notes = notes.filter((n) => n !== hat)
    }
  ]
  // Two different changes.
  const first = Math.floor(Math.random() * moves.length)
  const second = (first + 1 + Math.floor(Math.random() * (moves.length - 1))) % moves.length
  moves[first]()
  moves[second]()
  return notes
}

/**
 * A fill over the last beat of the clip: what was there makes way for a run
 * on the snare or down the toms that swells into the next bar.
 */
export function fill(clip: MidiClip, kit: Kit): Note[] {
  const steps = Math.max(4, Math.floor(clip.length / SIXTEENTH))
  const from = steps - 4
  const { snare, tomHigh, tomLow, kick, crash, ride } = kit.roles
  // Cymbals ring on through a fill; everything else in its way goes.
  const kept = clip.notes.filter((n) => stepOf(n) < from || n.pitch === crash || n.pitch === ride)
  const run = (pitches: (number | undefined)[], counts: number[]): Note[] =>
    pitches.flatMap((pitch, i) => (pitch === undefined || !counts[i] ? [] : hits(pitch, (from + i) * SIXTEENTH, SIXTEENTH, 0.55 + 0.15 * i, counts[i])))
  const shapes: Note[][] = [
    run([snare, snare, snare, snare], [1, 1, 1, 1]),
    run([tomHigh ?? snare, tomHigh ?? snare, tomLow ?? snare, tomLow ?? snare], [1, 1, 1, 1]),
    run([snare, snare, snare, snare], [1, 0, 2, 4]),
    run([snare, tomHigh ?? snare, tomLow ?? snare, snare], [1, 1, 1, 2])
  ]
  const lead = kick !== undefined ? hits(kick, from * SIXTEENTH, SIXTEENTH, NORMAL) : []
  return [...kept, ...lead, ...(pick(shapes) ?? shapes[0])]
}

/** Takes the machine out of the loudness: every hit a little louder or softer, at random. */
export function humanise(notes: Note[]): Note[] {
  return notes.map((note) => ({ ...note, velocity: Math.min(1, Math.max(0.2, note.velocity * (0.88 + Math.random() * 0.24))) }))
}
