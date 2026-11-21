/**
 * What the step sequencer knows about drums: which note is which sound in a
 * kit, a set of rhythms to start from, and ways to vary one. Everything here
 * works in notes of a MIDI clip; the sequencer is a way of writing them.
 */
import { DRUM_NAMES, newId, PPQ, type MidiClip, type Note, type Track } from '@shared/model'
import { DRUM_BANK } from './soundfont'

/** The parts of a kit a rhythm is written for. */
export type Role = 'kick' | 'snare' | 'clap' | 'rim' | 'hat' | 'open' | 'tomLow' | 'tomHigh' | 'crash' | 'ride' | 'cowbell' | 'shaker' | 'congaHigh' | 'congaLow'

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
  roles: { kick: 36, snare: 38, clap: 39, rim: 37, hat: 42, open: 46, tomLow: 45, tomHigh: 50, crash: 49, ride: 51, cowbell: 56, shaker: 70, congaHigh: 63, congaLow: 64 },
  names: GM_NAMES,
  rows: [49, 51, 46, 42, 39, 38, 50, 45, 36]
}

/** The engine's own drum machine has twelve sounds, one to each note name, in the octave from C2. */
const BUILT_IN_KIT: Kit = {
  roles: { kick: 36, snare: 38, clap: 39, rim: 37, hat: 42, open: 46, tomLow: 41, tomHigh: 45, cowbell: 47 },
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
  /** Its part of a style that has many, in `PATTERN_GROUPS`. */
  group?: string
  /** A tempo it sits well at, as a hint; nothing sets it. */
  bpm: string
  parts: Partial<Record<Role, string>>
}

/** The order of the groups within the styles that have them. */
export const PATTERN_GROUPS: Record<string, string[]> = {
  Reggaeton: ['Basics', 'Scenes', 'Dominican dembow', 'Kick', 'Snare', 'Hats and percussion', 'Fills and sections'],
  Detroit: ['Techno', 'Electro', 'Ghettotech', 'House']
}

export const PATTERNS: Pattern[] = [
  {
    name: 'Trap',
    style: 'Trap',
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
    style: 'Trap',
    bpm: '130–150',
    parts: {
      hat: 'x---x---x---x-2-x---x---x-3-x---',
      clap: '--------X---------------X-------',
      kick: 'X---------x-----X------x--x-----'
    }
  },
  {
    name: 'Drill',
    style: 'Drill',
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
    group: 'Basics',
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
    group: 'Basics',
    bpm: '88–100',
    parts: {
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Perreo',
    style: 'Reggaeton',
    group: 'Scenes',
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
    group: 'Basics',
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
    group: 'Fills and sections',
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
    group: 'Fills and sections',
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
    group: 'Scenes',
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
  },
  {
    name: 'Trap, bouncy',
    style: 'Trap',
    bpm: '130–150',
    parts: {
      hat: 'x-x-x-x-x-xxx-x-x-x-x-3-x-x-x-x-',
      clap: '--------X---------------X-------',
      kick: 'X--x--x-------x-X--x------x--x--'
    }
  },
  {
    name: 'Trap, rolling hats',
    style: 'Trap',
    bpm: '130–150',
    parts: {
      hat: 'x-x-3-x-x-x-3-x-x-x-3-x-x-3-4-x-',
      clap: '--------X---------------X-------',
      kick: 'X-------x-x-----X------x--x-----'
    }
  },
  {
    name: 'Trap, slow hats',
    style: 'Trap',
    bpm: '130–150',
    parts: {
      hat: 'x---x---x---x---x---x---x---x-3-',
      open: '------x---------------x---------',
      clap: '--------X---------------X-------',
      kick: 'X-----x-----x---X-----x---x-x---'
    }
  },
  {
    name: 'Drill, sliding',
    style: 'Drill',
    bpm: '138–145',
    parts: {
      hat: 'x-xx--x-x--x-x--x-xx--x-x--3--x-',
      snare: '--------X-----------------X-----',
      kick: 'X-----x--x------X--x-----x--x---'
    }
  },
  {
    name: 'Boom bap, heavy',
    style: 'Hip hop',
    bpm: '85–95',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X--o',
      kick: 'X-x----x--x-----'
    }
  },
  {
    name: 'Boom bap, two bars',
    style: 'Hip hop',
    bpm: '85–95',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '----X-------X-------X--o----X---',
      kick: 'X------x-x------X-x----x--x-----'
    }
  },
  {
    name: 'Old school',
    style: 'Hip hop',
    bpm: '95–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      clap: '----X-------X---',
      snare: '----X-------X---',
      kick: 'X-----x---x-----'
    }
  },
  {
    name: 'Crunk',
    style: 'Hip hop',
    bpm: '140–160',
    parts: {
      open: '--------------x-',
      hat: 'xxxxxxxxxxxxxxxx',
      clap: '--------X-------',
      kick: 'X---------x-x---'
    }
  },
  {
    name: 'Bounce',
    style: 'Hip hop',
    bpm: '95–105',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      clap: '----X-------X---',
      kick: 'X--x--x-X--x--x-'
    }
  },
  {
    name: 'G-funk',
    style: 'Hip hop',
    bpm: '90–100',
    parts: {
      open: '------x-------x-',
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X---',
      kick: 'X--x----x-x-----'
    }
  },
  {
    name: 'Phonk',
    style: 'Hip hop',
    bpm: '130–160',
    parts: {
      cowbell: 'x--x--x--x--x-x-',
      hat: 'x-x-x-x-x-x-x-x-',
      clap: '--------X-------',
      kick: 'X--x--x---x--x--'
    }
  },
  {
    name: 'Memphis',
    style: 'Hip hop',
    bpm: '130–150',
    parts: {
      cowbell: '--x---x---x---x-',
      hat: 'xxxxxxxxxxxxxxxx',
      snare: '--------X-------',
      kick: 'X-----x-x-----x-'
    }
  },
  {
    name: 'Cloud',
    style: 'Hip hop',
    bpm: '120–140',
    parts: {
      hat: 'x---x---x-x-x---',
      snare: '--------X-------',
      kick: 'X---------x--x--'
    }
  },
  {
    name: 'Jersey club',
    style: 'Hip hop',
    bpm: '130–140',
    parts: {
      clap: '----X-------X---',
      kick: 'X---X---X--X--X-'
    }
  },
  {
    name: 'Trap soul',
    style: 'R&B',
    bpm: '120–140',
    parts: {
      hat: 'x-x-x-x-x-3-x-x-',
      snare: '--------X-------',
      kick: 'X-------x-x-----'
    }
  },
  {
    name: 'Slow jam',
    style: 'R&B',
    bpm: '60–75',
    parts: {
      hat: 'x-xxx-x-x-xxx-x-',
      snare: '----X-------X---',
      kick: 'X------x--x-----'
    }
  },
  {
    name: 'New jack swing',
    style: 'R&B',
    bpm: '100–110',
    parts: {
      hat: 'x-xxx-xxx-xxx-xx',
      snare: '----X--x----X---',
      kick: 'X--x--x---x-x---'
    }
  },
  {
    name: 'Motown',
    style: 'R&B',
    bpm: '110–130',
    parts: {
      shaker: 'x-x-x-x-x-x-x-x-',
      hat: 'x-x-x-x-x-x-x-x-',
      snare: 'X---X---X---X---',
      kick: 'X-----x-X-----x-'
    }
  },
  {
    name: 'Pop, straight',
    style: 'Pop',
    bpm: '100–120',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X---',
      kick: 'X-----x-X-------'
    }
  },
  {
    name: 'Dance pop',
    style: 'Pop',
    bpm: '115–128',
    parts: {
      hat: '--x---x---x---x-',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Tropical',
    style: 'Pop',
    bpm: '95–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      clap: '----X-------X---',
      kick: 'X--x--x-X--x--x-'
    }
  },
  {
    name: 'Synthwave',
    style: 'Pop',
    bpm: '80–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Deep house',
    style: 'House',
    bpm: '118–124',
    parts: {
      open: '--x---x---x---x-',
      hat: 'o-o-o-o-o-o-o-o-',
      rim: '-------x--x-----',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Tech house',
    style: 'House',
    bpm: '122–128',
    parts: {
      open: '--x---x---x---x-',
      hat: 'x-xxx-xxx-xxx-xx',
      tomLow: '---------x-----x',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Acid house',
    style: 'House',
    bpm: '120–130',
    parts: {
      cowbell: '--------x--x--x-',
      hat: 'xxXxxxXxxxXxxxXx',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Garage, four to the floor',
    style: 'Garage',
    bpm: '128–135',
    parts: {
      open: '--x---x---x---x-',
      hat: 'x-xxx-xxx-xxx-xx',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Grime',
    style: 'Garage',
    bpm: '138–142',
    parts: {
      hat: 'x---x---x---x---',
      snare: '----X-------X---',
      kick: 'X--x--x-----x---'
    }
  },
  {
    name: 'Techno, driving',
    style: 'Techno',
    bpm: '128–140',
    parts: {
      open: '--x---x---x---x-',
      hat: 'oxoxoxoxoxoxoxox',
      clap: '------------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Techno, minimal',
    style: 'Techno',
    bpm: '124–132',
    parts: {
      hat: '--x---x---x---x-',
      rim: '---x--x----x----',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Trance',
    style: 'Techno',
    bpm: '132–140',
    parts: {
      open: '--x---x---x---x-',
      hat: 'oooooooooooooooo',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Electro',
    style: 'Techno',
    bpm: '120–130',
    parts: {
      cowbell: '--x-x---x-x-x---',
      hat: 'x-xxx-xxx-xxx-xx',
      snare: '----X-------X---',
      kick: 'X--x--x---x-----'
    }
  },
  {
    name: 'Dubstep',
    style: 'Bass music',
    bpm: '138–142',
    parts: {
      hat: 'x-x-xxx-x-x-x-x-x-x-xxx-x-x-x-3-',
      snare: '--------X---------------X-------',
      kick: 'X---------x-----X--x------x-----'
    }
  },
  {
    name: 'Future bass',
    style: 'Bass music',
    bpm: '140–160',
    parts: {
      hat: 'x-x-x-3-x-x-x-x-',
      clap: '--------X-------',
      snare: '--------X-------',
      kick: 'X-----x---x-----'
    }
  },
  {
    name: 'Footwork',
    style: 'Bass music',
    bpm: '155–165',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      rim: '---x--x----x--x-',
      clap: '------------X---',
      kick: 'X--x--x-X--x--x-'
    }
  },
  {
    name: 'Jungle break',
    style: 'Breakbeat',
    bpm: '160–175',
    parts: {
      ride: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '----X--o-o--X--o----X--o-o----X-',
      kick: 'X-X-------xx----X-X-------x-----'
    }
  },
  {
    name: 'Roller',
    style: 'Breakbeat',
    bpm: '170–176',
    parts: {
      hat: 'x-xxx-xxx-xxx-xx',
      snare: '----X-------X---',
      kick: 'X---------x-----'
    }
  },
  {
    name: 'Liquid',
    style: 'Breakbeat',
    bpm: '170–176',
    parts: {
      ride: 'x-x-x-x-x-x-x-x-',
      hat: 'oooooooooooooooo',
      snare: '----X-------X---',
      kick: 'X---------x--x--'
    }
  },
  {
    name: 'Big beat',
    style: 'Breakbeat',
    bpm: '110–130',
    parts: {
      open: '------x-------x-',
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X---',
      kick: 'X--x------x-x---'
    }
  },
  {
    name: 'Afrobeats',
    style: 'Afro',
    bpm: '100–115',
    parts: {
      shaker: 'xoxoxoxoxoxoxoxo',
      rim: '---x--x----x--x-',
      kick: 'X-----x-X-----x-'
    }
  },
  {
    name: 'Afrobeats, laid back',
    style: 'Afro',
    bpm: '95–110',
    parts: {
      shaker: 'x-x-x-x-x-x-x-x-',
      congaHigh: '--x-----x-x-----',
      rim: '---x--x----x--x-',
      kick: 'X-------x-x-----'
    }
  },
  {
    name: 'Afrobeat',
    style: 'Afro',
    bpm: '100–125',
    parts: {
      shaker: 'x-x-x-x-x-x-x-x-',
      hat: 'xxxxxxxxxxxxxxxx',
      snare: '----o--x-o--x--o',
      kick: 'X--x---x--x-----'
    }
  },
  {
    name: 'Amapiano',
    style: 'Afro',
    bpm: '110–115',
    parts: {
      shaker: 'xoxoxoxoxoxoxoxo',
      open: '------x-------x-',
      rim: '---x--x---x--x--',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Afro house',
    style: 'Afro',
    bpm: '118–124',
    parts: {
      shaker: 'xoxoxoxoxoxoxoxo',
      congaHigh: '--x--x----x--x--',
      congaLow: '------x-------x-',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Soca',
    style: 'Caribbean',
    bpm: '115–135',
    parts: {
      cowbell: 'x-x-x-x-x-x-x-x-',
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Tresillo',
    style: 'Caribbean',
    bpm: '90–120',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      kick: 'X--x--x-X--x--x-'
    }
  },
  {
    name: 'Ska',
    style: 'Reggae',
    bpm: '120–160',
    parts: {
      hat: '--x---x---x---x-',
      snare: '----X-------X---',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dub',
    style: 'Reggae',
    bpm: '130–150',
    parts: {
      open: '--------------x-',
      hat: 'x-x-x-x-x-x-x-x-',
      rim: '--------X--o--o-',
      kick: '--------X-------'
    }
  },
  {
    name: 'Flying cymbal',
    style: 'Reggae',
    bpm: '130–150',
    parts: {
      open: '--x---x---x---x-',
      snare: '--------X-------',
      kick: '--------X-------'
    }
  },
  {
    name: 'One drop, slow count',
    style: 'Reggae',
    bpm: '65–80',
    parts: {
      hat: 'xoxoxoxoxoxoxoxo',
      rim: '----X-------X---',
      kick: '----X-------X---'
    }
  },
  {
    name: 'Rockers, slow count',
    style: 'Reggae',
    bpm: '65–80',
    parts: {
      hat: 'xoxoxoxoxoxoxoxo',
      snare: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Steppers, slow count',
    style: 'Reggae',
    bpm: '65–80',
    parts: {
      hat: 'xoxoxoxoxoxoxoxo',
      snare: '----X-------X---',
      kick: 'X-x-X-x-X-x-X-x-'
    }
  },
  {
    name: 'Dancehall, heavy',
    style: 'Dancehall',
    bpm: '90–110',
    parts: {
      hat: 'xoxoxoxoxoxoxoxo',
      snare: '------X-------X-',
      kick: 'X--x----X--x--x-'
    }
  },
  {
    name: 'Dancehall, sparse',
    style: 'Dancehall',
    bpm: '90–110',
    parts: {
      clap: '------X-------X-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Reggaeton, doubled snare',
    style: 'Reggaeton',
    group: 'Snare',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--xx',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, open hats',
    style: 'Reggaeton',
    group: 'Hats and percussion',
    bpm: '88–100',
    parts: {
      open: '--x---x---x---x-',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, half kick',
    style: 'Reggaeton',
    group: 'Kick',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dembow, fast',
    style: 'Reggaeton',
    group: 'Dominican dembow',
    bpm: '115–125',
    parts: {
      hat: 'xxxxxxxxxxxxxxxx',
      tomHigh: '------x-------x-',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Son clave',
    style: 'Latin',
    bpm: '85–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      rim: 'x--x--x---x-x---',
      kick: '------x-------x-'
    }
  },
  {
    name: 'Rumba clave',
    style: 'Latin',
    bpm: '85–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      rim: 'x--x---x--x-x---',
      kick: '------x-------x-'
    }
  },
  {
    name: 'Salsa',
    style: 'Latin',
    bpm: '85–110',
    parts: {
      ride: 'x-x-xx-xx-xx-x-x',
      rim: '--x-x---x--x--x-',
      congaHigh: '--x-------x-----',
      congaLow: '------xx------xx',
      kick: '---x--x----x--x-'
    }
  },
  {
    name: 'Bossa nova',
    style: 'Latin',
    bpm: '65–80',
    parts: {
      hat: 'oooooooooooooooo',
      rim: 'x--x--x---x--x--',
      kick: 'X--xX--xX--xX--x'
    }
  },
  {
    name: 'Samba',
    style: 'Latin',
    bpm: '90–105',
    parts: {
      shaker: 'XooXXooXXooXXooX',
      rim: 'x-x-xx-x-x-x-xx-',
      kick: 'X--xX--xX--xX--x'
    }
  },
  {
    name: 'Cumbia',
    style: 'Latin',
    bpm: '85–100',
    parts: {
      shaker: 'x-xxx-xxx-xxx-xx',
      rim: '----X-------X---',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Rock, driving',
    style: 'Rock',
    bpm: '110–140',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X---',
      kick: 'X-----x-X-x-----'
    }
  },
  {
    name: 'Dance rock',
    style: 'Rock',
    bpm: '115–130',
    parts: {
      open: '--x---x---x---x-',
      snare: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Punk',
    style: 'Rock',
    bpm: '160–200',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X---',
      kick: 'X-x---x-X-x---x-'
    }
  },
  {
    name: 'Metal, double kick',
    style: 'Rock',
    bpm: '100–140',
    parts: {
      crash: 'X---------------',
      ride: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X---',
      kick: 'xxxxxxxxxxxxxxxx'
    }
  },
  {
    name: 'Twist',
    style: 'Rock',
    bpm: '140–170',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-x-----X---',
      kick: 'X-----x-X-----x-'
    }
  },
  {
    name: 'Bo Diddley',
    style: 'Rock',
    bpm: '90–110',
    parts: {
      shaker: 'x-x-x-x-x-x-x-x-',
      tomLow: 'x--x--x---x-x---',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Train beat',
    style: 'Country',
    bpm: '90–120',
    parts: {
      snare: 'ooooXoooooooXooo',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Funk, tight',
    style: 'Funk',
    bpm: '95–110',
    parts: {
      hat: 'xxxxxxxxxxxxxxxx',
      snare: '----X--o-o--X---',
      kick: 'X-x-------x--x--'
    }
  },
  {
    name: 'Funk, busy',
    style: 'Funk',
    bpm: '95–110',
    parts: {
      open: '----------x-----',
      hat: 'xxxxxxxxxxxxxxxx',
      snare: '----X--o-o-oX--o',
      kick: 'X-x---x---x--x--'
    }
  },
  {
    name: 'Go-go',
    style: 'Funk',
    bpm: '90–105',
    parts: {
      cowbell: 'x-x-x-x-x-x-x-x-',
      congaHigh: 'x-xx-xx-x-xx-xx-',
      snare: '----X-------X---',
      kick: 'X-----x---x-x---'
    }
  },
  {
    name: 'Trap, Atlanta',
    style: 'Trap',
    bpm: '130–150',
    parts: {
      hat: 'x-x-x-x-x-x-x-3-x-x-x-x-x-4-x-x-',
      clap: '--------X---------------X-------',
      kick: 'X-----x---x--x--X-----x-x-----x-'
    }
  },
  {
    name: 'Trap, hard',
    style: 'Trap',
    bpm: '140–160',
    parts: {
      hat: 'xxx-x-x-xxx-x-x-xxx-x-x-x-3-4-x-',
      snare: '------------------------------o-',
      clap: '--------X---------------X-------',
      kick: 'X--x--x---x-----X--x--x--x--x---'
    }
  },
  {
    name: 'Trap, dark',
    style: 'Trap',
    bpm: '130–145',
    parts: {
      open: '------------x---------------x---',
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-3-x-x-x-',
      clap: '--------X---------------X-------',
      kick: 'X---------x--x----x---x---x-----'
    }
  },
  {
    name: 'Trap, melodic',
    style: 'Trap',
    bpm: '130–150',
    parts: {
      hat: 'x-x-x-3-x-x-x-x-x-x-x-3-x-x-4-x-',
      rim: '--------------x---------------x-',
      clap: '--------X---------------X-------',
      kick: 'X-----x-------x-X-----x---x-----'
    }
  },
  {
    name: 'Trap, triplet hats',
    style: 'Trap',
    bpm: '130–150',
    parts: {
      hat: 'x-3-x-3-x-3-x-3-x-3-x-3-x-4-x-33',
      clap: '--------X---------------X-------',
      kick: 'X-------x-x-----X---x-----x-----'
    }
  },
  {
    name: 'Trap, fast hats',
    style: 'Trap',
    bpm: '130–150',
    parts: {
      hat: 'xxxxxxxxxxxxxx3-xxxxxxxxxxxx4-33',
      clap: '--------X---------------X-------',
      kick: 'X-----x---x-----X--x------x--x--'
    }
  },
  {
    name: 'Trap, snare roll',
    style: 'Trap',
    bpm: '130–150',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '--------------------------x-2344',
      clap: '--------X---------------X-------',
      kick: 'X-----x---x-----X-----x---------'
    }
  },
  {
    name: 'Trap, open hats',
    style: 'Trap',
    bpm: '130–150',
    parts: {
      open: '--x-----------x---x-----------x-',
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      clap: '--------X---------------X-------',
      kick: 'X--x------x-----X--x----x-x-----'
    }
  },
  {
    name: 'Trap, hats come in',
    style: 'Trap',
    bpm: '130–150',
    parts: {
      hat: '----------------x-x-x-x-x-x-3-x-',
      clap: '--------X---------------X-------',
      kick: 'X---------x-----X-----x---x-----'
    }
  },
  {
    name: 'Trap, flam clap',
    style: 'Trap',
    bpm: '130–150',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-3-x-x-',
      clap: '-------oX--------------oX-------',
      kick: 'X-----x---x-----X---x---x-x-----'
    }
  },
  {
    name: 'Trap, heavy kick',
    style: 'Trap',
    bpm: '130–150',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      clap: '--------X---------------X-------',
      kick: 'X-x---x---x-x---X-x-----x-x--x--'
    }
  },
  {
    name: 'Rage',
    style: 'Trap',
    bpm: '140–160',
    parts: {
      hat: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxx3-4-',
      clap: '--------X---------------X-------',
      kick: 'X--x--x--x--x-x-X--x--x--x--x---'
    }
  },
  {
    name: 'Plugg',
    style: 'Trap',
    bpm: '140–150',
    parts: {
      open: '------x-----------------------x-',
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      clap: '--------X---------------X-------',
      kick: 'X-------x---x---X-----x---x-----'
    }
  },
  {
    name: 'Ratchet',
    style: 'Trap',
    bpm: '95–105',
    parts: {
      hat: '--x---x---x---x-',
      clap: '----X-------X---',
      kick: 'X--x----x-x-----'
    }
  },
  {
    name: 'Detroit rap',
    style: 'Trap',
    bpm: '95–105',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      clap: '----X-------X---',
      kick: 'X--x--x---x--x--'
    }
  },
  {
    name: 'Drill, UK',
    style: 'Drill',
    bpm: '138–145',
    parts: {
      hat: 'x--x--x-x--x--x-x--x--x-x--x--3-',
      snare: '--------X-------------------X---',
      kick: 'X--------x------X-----x--x------'
    }
  },
  {
    name: 'Drill, New York',
    style: 'Drill',
    bpm: '140–145',
    parts: {
      hat: 'x--x--x-x--x--x-x--x--x-x-3x--x-',
      snare: '--------X---------------X-------',
      clap: '--------X---------------X-------',
      kick: 'X--x--x-----x---X--x------x-x---'
    }
  },
  {
    name: 'Drill, Chicago',
    style: 'Drill',
    bpm: '130–140',
    parts: {
      hat: 'x-x-x-x-x-x-3-x-x-x-x-x-x-4-x-x-',
      snare: '--------X---------------X-------',
      kick: 'X--x------x-x---X--x----x-x-----'
    }
  },
  {
    name: 'Drill, dark',
    style: 'Drill',
    bpm: '138–145',
    parts: {
      open: '--------------x---------------x-',
      hat: 'x--x--x-x--x--x-',
      snare: '--------X-----------------X-----',
      kick: 'X-----x-----x---X--x--------x---'
    }
  },
  {
    name: 'Drill, rolling',
    style: 'Drill',
    bpm: '138–145',
    parts: {
      hat: 'x--x--3-x--x--x-x--x--3-x--4--x-',
      snare: '--------X-------------------X---',
      kick: 'X--x-----x------X-----x---x--x--'
    }
  },
  {
    name: 'Drill, bouncy',
    style: 'Drill',
    bpm: '140–145',
    parts: {
      hat: 'x-xx-xx-x-xx-xx-x-xx-xx-x-xx-3x-',
      snare: '--------X-----------------X-----',
      kick: 'X--x--x---x-----X--x--x-----x-x-'
    }
  },
  {
    name: 'Drill, sparse',
    style: 'Drill',
    bpm: '138–145',
    parts: {
      hat: 'x--x--x-x--x--x-',
      snare: '--------X-------------------X---',
      kick: 'X---------------X--------x------'
    }
  },
  {
    name: 'Drill, counter snare',
    style: 'Drill',
    bpm: '138–145',
    parts: {
      hat: 'x--x--x-x--x--x-',
      snare: '--------X--o-------------oX-----',
      kick: 'X--x------x-----X--x--x---------'
    }
  },
  {
    name: 'Drill, triplet hats',
    style: 'Drill',
    bpm: '138–145',
    parts: {
      hat: 'x--3--x-x--3--x-x--3--x-x--3-34-',
      snare: '--------X-----------------X-----',
      kick: 'X--x-----x--x---X-----x--x------'
    }
  },
  {
    name: 'Jersey drill',
    style: 'Drill',
    bpm: '140–150',
    parts: {
      hat: 'x--x--x-x--x--x-',
      clap: '----X-------X---',
      kick: 'X---X---X--X--X-'
    }
  },
  {
    name: 'Reggaeton, old school',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '90–98',
    parts: {
      hat: 'XoxoXoxoXoxoXoxo',
      snare: '---X--x----X--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, 2000s',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '92–98',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      tomHigh: '--------------x-',
      clap: '---X-------X----',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, modern',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '88–96',
    parts: {
      hat: '--x---x---x---x-',
      rim: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, pop',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '90–100',
    parts: {
      shaker: 'x-x-x-x-x-x-x-x-',
      clap: '----X-------X---',
      snare: '---o--x----o--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, romantic',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '80–92',
    parts: {
      shaker: 'xoxoxoxoxoxoxoxo',
      congaHigh: '------x-------x-',
      rim: '---x--x----x--x-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Reggaeton, slow',
    style: 'Reggaeton',
    group: 'Basics',
    bpm: '78–88',
    parts: {
      shaker: 'o-x-o-x-o-x-o-x-',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, hard',
    style: 'Reggaeton',
    group: 'Basics',
    bpm: '92–102',
    parts: {
      hat: 'xxxxxxxxxxxxxxxx',
      clap: '---X--X----X--X-',
      snare: '---X--X----X--X-',
      kick: 'X--xX---X--xX---'
    }
  },
  {
    name: 'Reggaeton, mexa',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '90–100',
    parts: {
      open: '--------------x-',
      hat: 'x-x-x-x-x-x-x-x-',
      clap: '---X--X----X--X-',
      kick: 'X---X---X---X-x-'
    }
  },
  {
    name: 'Reggaeton, afro',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '95–105',
    parts: {
      shaker: 'xoxoxoxoxoxoxoxo',
      rim: '---x--x----x--x-',
      clap: '----x-------x---',
      kick: 'X-----x-X-----x-'
    }
  },
  {
    name: 'Perreo, intenso',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '95–105',
    parts: {
      open: '--x---x---x---x-',
      hat: 'xxxxxxxxxxxxxxxx',
      clap: '---X--X----X--X-',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Perreo, dark',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '90–100',
    parts: {
      tomLow: '------------x-x-',
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---X--X----X--X-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Perreo, bare',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '90–100',
    parts: {
      clap: '---X--X----X--X-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Neoperreo',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '95–105',
    parts: {
      open: '--------------x-',
      hat: 'x-xxx-xxx-xxx-xx',
      clap: '---X--X----X--X-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'RKT',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '95–100',
    parts: {
      cowbell: 'x-x-x-x-x-x-x-x-',
      shaker: 'x-xxx-xxx-xxx-xx',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Cumbiatón',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '88–98',
    parts: {
      shaker: 'x-xxx-xxx-xxx-xx',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Bachatón',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '85–95',
    parts: {
      shaker: 'x-x-x-x-x-x-x-x-',
      congaHigh: 'x-x-xx-xx-x-xx-x',
      rim: '---x--x----x--x-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Trapeton',
    style: 'Reggaeton',
    group: 'Scenes',
    bpm: '85–95',
    parts: {
      hat: 'x-x-x-3-x-x-x-x-x-x-x-x-x-3-x-4-',
      snare: '---x--x----x--x----x--x----x--x-',
      kick: 'X--x--x-X---x---X--x--x-X-----x-'
    }
  },
  {
    name: 'Dembow, Dominican',
    style: 'Reggaeton',
    group: 'Dominican dembow',
    bpm: '115–130',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x--X----x--X-',
      kick: 'X--xX---X--xX---'
    }
  },
  {
    name: 'Dembow, Dominican, bare',
    style: 'Reggaeton',
    group: 'Dominican dembow',
    bpm: '115–130',
    parts: {
      rim: '---x--x----x--x-',
      kick: 'X--xX---X--xX---'
    }
  },
  {
    name: 'Dembow, Dominican, heavy',
    style: 'Reggaeton',
    group: 'Dominican dembow',
    bpm: '115–130',
    parts: {
      hat: 'xxxxxxxxxxxxxxxx',
      tomHigh: '------x-------x-',
      snare: '---X--X----X--X-',
      kick: 'X--xX--xX--xX--x'
    }
  },
  {
    name: 'Reggaeton, double kick',
    style: 'Reggaeton',
    group: 'Kick',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x-',
      kick: 'X---X--xX---X--x'
    }
  },
  {
    name: 'Reggaeton, pushed kick',
    style: 'Reggaeton',
    group: 'Kick',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X-x-'
    }
  },
  {
    name: 'Reggaeton, kick follows',
    style: 'Reggaeton',
    group: 'Kick',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      clap: '----X-------X---',
      kick: 'X--x--x-X--x--x-'
    }
  },
  {
    name: 'Reggaeton, kick drops out',
    style: 'Reggaeton',
    group: 'Fills and sections',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x----x--x----x--x-',
      kick: 'X---X---X---X---X---X---X-------'
    }
  },
  {
    name: 'Reggaeton, break',
    style: 'Reggaeton',
    group: 'Fills and sections',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x----x--x----x--x-',
      kick: 'X---------------X---------------'
    }
  },
  {
    name: 'Reggaeton, intro',
    style: 'Reggaeton',
    group: 'Fills and sections',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      rim: '---x--x----x--x-'
    }
  },
  {
    name: 'Reggaeton, build',
    style: 'Reggaeton',
    group: 'Fills and sections',
    bpm: '88–100',
    parts: {
      snare: 'x---x---x---x---x-x-x-x-xxxx2222',
      kick: 'X---X---X---X---X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, drop',
    style: 'Reggaeton',
    group: 'Fills and sections',
    bpm: '88–100',
    parts: {
      crash: 'X-------------------------------',
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '---X--X----X--X----X--X----X--X-',
      kick: 'X---X---X---X---X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, snare variation',
    style: 'Reggaeton',
    group: 'Snare',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x--x---xx--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, late snare',
    style: 'Reggaeton',
    group: 'Snare',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x---x---x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, ghost snares',
    style: 'Reggaeton',
    group: 'Snare',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: 'o--Xo-X-o--Xo-X-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, rim and snare',
    style: 'Reggaeton',
    group: 'Snare',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      rim: '---x-------x----',
      snare: '------X-------X-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, backbeat clap',
    style: 'Reggaeton',
    group: 'Snare',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      rim: '---x--x----x--x-',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, two-bar snare',
    style: 'Reggaeton',
    group: 'Snare',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x----x--x---xx--xx',
      kick: 'X---X---X---X---X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, switch-up',
    style: 'Reggaeton',
    group: 'Fills and sections',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x-----X-------X---',
      kick: 'X---X---X---X---X--x--x-X--x--x-'
    }
  },
  {
    name: 'Reggaeton, cowbell',
    style: 'Reggaeton',
    group: 'Hats and percussion',
    bpm: '88–100',
    parts: {
      cowbell: '--x---x---x---x-',
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, congas',
    style: 'Reggaeton',
    group: 'Hats and percussion',
    bpm: '88–100',
    parts: {
      shaker: 'x-x-x-x-x-x-x-x-',
      congaHigh: '--x-------x--x--',
      congaLow: '------xx------x-',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, shaker',
    style: 'Reggaeton',
    group: 'Hats and percussion',
    bpm: '88–100',
    parts: {
      shaker: 'XoxoXoxoXoxoXoxo',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, hat rolls',
    style: 'Reggaeton',
    group: 'Hats and percussion',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-3-x-x-x-x-x-x-2-4-',
      snare: '---x--x----x--x----x--x----x--x-',
      kick: 'X---X---X---X---X---X---X---X---'
    }
  },
  {
    name: 'Reggaeton, tom fill',
    style: 'Reggaeton',
    group: 'Fills and sections',
    bpm: '88–100',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      tomHigh: '------------------------x-xx----',
      tomLow: '----------------------------x-xx',
      snare: '---x--x----x--x----x--x---------',
      kick: 'X---X---X---X---X---X---X---X---'
    }
  },
  {
    name: 'Detroit techno',
    style: 'Detroit',
    group: 'Techno',
    bpm: '125–135',
    parts: {
      open: '--x---x---x---x-',
      hat: 'xoxoxoxoxoxoxoxo',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Detroit techno, ride',
    style: 'Detroit',
    group: 'Techno',
    bpm: '125–135',
    parts: {
      ride: 'x-x-x-x-x-x-x-x-',
      open: '--x---x---x---x-',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Detroit techno, rimshot',
    style: 'Detroit',
    group: 'Techno',
    bpm: '125–135',
    parts: {
      open: '--x---x---x---x-',
      hat: 'xoxoxoxoxoxoxoxo',
      rim: '--x--x--x--x-x--',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Detroit techno, toms',
    style: 'Detroit',
    group: 'Techno',
    bpm: '125–135',
    parts: {
      open: '--x---x---x---x-',
      tomHigh: '--x-----x--x----',
      tomLow: '-----x-------x-x',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Detroit techno, minimal',
    style: 'Detroit',
    group: 'Techno',
    bpm: '128–136',
    parts: {
      hat: '--x---x---x---x-',
      rim: '-------x--x-----',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Detroit techno, shuffled hats',
    style: 'Detroit',
    group: 'Techno',
    bpm: '125–135',
    parts: {
      open: '--x---x---x---x-',
      hat: 'x-xxx-xxx-xxx-xx',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Detroit techno, hard',
    style: 'Detroit',
    group: 'Techno',
    bpm: '135–145',
    parts: {
      ride: 'x-x-x-x-x-x-x-x-',
      open: '--x---x---x---x-',
      hat: 'XoxoXoxoXoxoXoxo',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Detroit techno, broken',
    style: 'Detroit',
    group: 'Techno',
    bpm: '125–135',
    parts: {
      open: '--x---x---x---x-',
      hat: 'xoxoxoxoxoxoxoxo',
      clap: '----X-------X---',
      kick: 'X--x--x---x-X---'
    }
  },
  {
    name: 'Detroit techno, soulful',
    style: 'Detroit',
    group: 'Techno',
    bpm: '122–130',
    parts: {
      shaker: 'xoxoxoxoxoxoxoxo',
      open: '--x---x---x---x-',
      rim: '---x--x----x-x--',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Detroit techno, no clap',
    style: 'Detroit',
    group: 'Techno',
    bpm: '128–136',
    parts: {
      open: '--x---x---x---x-',
      hat: 'xxxxxxxxxxxxxxxx',
      tomLow: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Detroit techno, with a fill',
    style: 'Detroit',
    group: 'Techno',
    bpm: '125–135',
    parts: {
      open: '--x---x---x---x---x---x---x---x-',
      hat: 'xoxoxoxoxoxoxoxoxoxoxoxoxoxoxoxo',
      snare: '--------------------------x-x234',
      clap: '----X-------X-------X-----------',
      kick: 'X---X---X---X---X---X---X---X---'
    }
  },
  {
    name: 'Detroit techno, kick drops out',
    style: 'Detroit',
    group: 'Techno',
    bpm: '125–135',
    parts: {
      open: '--x---x---x---x---x---x---x---x-',
      hat: 'xoxoxoxoxoxoxoxoxoxoxoxoxoxoxoxo',
      clap: '----X-------X-------X-------X---',
      kick: 'X---X---X---X---X---X---X-------'
    }
  },
  {
    name: 'Detroit electro',
    style: 'Detroit',
    group: 'Electro',
    bpm: '125–140',
    parts: {
      hat: 'xxxxxxxxxxxxxxxx',
      snare: '----X-------X---',
      kick: 'X-----x---x--x--'
    }
  },
  {
    name: 'Detroit electro, cowbell',
    style: 'Detroit',
    group: 'Electro',
    bpm: '125–140',
    parts: {
      cowbell: 'x-xx-x-xx-x-x-x-',
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X---',
      kick: 'X--x--x---x-----'
    }
  },
  {
    name: 'Detroit electro, dark',
    style: 'Detroit',
    group: 'Electro',
    bpm: '125–135',
    parts: {
      open: '--------------x-',
      hat: '--x---x---x---x-',
      snare: '----X-------X---',
      kick: 'X--x----x-x-----'
    }
  },
  {
    name: 'Detroit electro, fast',
    style: 'Detroit',
    group: 'Electro',
    bpm: '140–150',
    parts: {
      hat: 'XoxoXoxoXoxoXoxo',
      clap: '----X-------X---',
      snare: '----X-------X---',
      kick: 'X--x--x---x--x--'
    }
  },
  {
    name: 'Detroit electro, sparse',
    style: 'Detroit',
    group: 'Electro',
    bpm: '125–140',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X--o',
      kick: 'X---------x-----'
    }
  },
  {
    name: 'Detroit electro, claps',
    style: 'Detroit',
    group: 'Electro',
    bpm: '125–140',
    parts: {
      hat: 'xxxxxxxxxxxxxxxx',
      clap: '----X--x----X-x-',
      kick: 'X-----x---x-x---'
    }
  },
  {
    name: 'Detroit electro, snare rolls',
    style: 'Detroit',
    group: 'Electro',
    bpm: '125–140',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '----X-------X-------X-----x-2344',
      kick: 'X-----x---x--x--X-----x---x-----'
    }
  },
  {
    name: 'Techno bass',
    style: 'Detroit',
    group: 'Electro',
    bpm: '130–145',
    parts: {
      open: '--x---x---x---x-',
      hat: 'xoxoxoxoxoxoxoxo',
      clap: '----X-------X---',
      kick: 'X--x--x-X--x--x-'
    }
  },
  {
    name: 'Techno bass, booming',
    style: 'Detroit',
    group: 'Electro',
    bpm: '130–145',
    parts: {
      hat: 'xxxxxxxxxxxxxxxx',
      snare: '----X-------X---',
      kick: 'X-----x-x-x---x-'
    }
  },
  {
    name: 'Ghettotech',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '150–165',
    parts: {
      open: '--x---x---x---x-',
      hat: 'xoxoxoxoxoxoxoxo',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Ghettotech, bare',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '150–165',
    parts: {
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Ghettotech, electro',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '150–165',
    parts: {
      hat: 'xxxxxxxxxxxxxxxx',
      clap: '----X-------X---',
      kick: 'X--x--x-X--x----'
    }
  },
  {
    name: 'Ghettotech, booty',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '145–160',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      clap: '----X-------X---',
      snare: '-------x-------x',
      kick: 'X--x--X---x-X---'
    }
  },
  {
    name: 'Ghettotech, claps',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '150–165',
    parts: {
      open: '--x---x---x---x-',
      clap: '----X--x-x--X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Ghettotech, rolling kick',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '150–165',
    parts: {
      open: '--x---x---x---x-',
      clap: '----X-------X---',
      kick: 'X-x-X-x-X-x-X-xx'
    }
  },
  {
    name: 'Ghettotech, toms',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '150–165',
    parts: {
      open: '--x---x---x---x-',
      tomHigh: '---x-----x------',
      tomLow: '------x-------xx',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Ghettotech, cowbell',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '150–165',
    parts: {
      cowbell: 'x--x--x-x--x--x-',
      open: '--x---x---x---x-',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Ghettotech, hard',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '160–170',
    parts: {
      open: '--x---x---x---x-',
      hat: 'xxxxxxxxxxxxxxxx',
      snare: '---x--x----x--x-',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Ghettotech, snare rush',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '150–165',
    parts: {
      open: '--x---x---x---x---x---x---x---x-',
      snare: '----------------x-x-x-x-xxxx2244',
      clap: '----X-------X-------------------',
      kick: 'X---X---X---X---X---X---X---X---'
    }
  },
  {
    name: 'Ghettotech, break',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '150–165',
    parts: {
      hat: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
      clap: '----X-------X-------X--x-x--X-xx',
      kick: 'X---X---X---X---X---------------'
    }
  },
  {
    name: 'Detroit jit',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '150–165',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '--x--x----x--x--',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Ghetto house',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '125–140',
    parts: {
      open: '--x---x---x---x-',
      tomLow: '---x--x----x--x-',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Ghetto house, raw',
    style: 'Detroit',
    group: 'Ghettotech',
    bpm: '125–140',
    parts: {
      hat: 'xxxxxxxxxxxxxxxx',
      clap: '----X-------X-xx',
      kick: 'X---X---X---X-x-'
    }
  },
  {
    name: 'Detroit house',
    style: 'Detroit',
    group: 'House',
    bpm: '118–126',
    parts: {
      shaker: 'xoxoxoxoxoxoxoxo',
      open: '--x---x---x---x-',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Detroit house, raw',
    style: 'Detroit',
    group: 'House',
    bpm: '118–126',
    parts: {
      open: '--x---x---x---x-',
      hat: 'x-xxx-xxx-xxx-xx',
      clap: '---oX------oX---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Detroit house, congas',
    style: 'Detroit',
    group: 'House',
    bpm: '118–126',
    parts: {
      open: '--x---x---x---x-',
      congaHigh: '--x--x----x--x--',
      congaLow: '-------x-------x',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Detroit house, rimshot',
    style: 'Detroit',
    group: 'House',
    bpm: '118–126',
    parts: {
      open: '--x---x---x---x-',
      hat: 'xoxoxoxoxoxoxoxo',
      rim: '--x--x-x--x--x--',
      clap: '----X-------X---',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Beatdown',
    style: 'Detroit',
    group: 'House',
    bpm: '105–118',
    parts: {
      open: '--x---x---x---x-',
      hat: 'o-x-o-x-o-x-o-x-',
      clap: '---oX------oX---',
      kick: 'X---X---X---X--x'
    }
  }
]

const SIXTEENTH = PPQ / 4

/** What plays a part on a kit that lacks it. */
const STAND_INS: Partial<Record<Role, Role>> = { clap: 'snare', rim: 'snare', crash: 'open', ride: 'hat', open: 'hat', shaker: 'hat', cowbell: 'rim', congaHigh: 'tomHigh', congaLow: 'tomLow' }

/**
 * The notes that play a pattern on a kit for `length` ticks. A part the kit
 * lacks is played by the nearest thing it has (a clap by the snare, a
 * shaker by the hat) or left out; where that would put two hits on one
 * drum at once, the part written for that drum keeps the step.
 */
export function patternNotes(pattern: Pattern, kit: Kit, length: number): Note[] {
  const parts = Object.entries(pattern.parts) as [Role, string][]
  // Parts the kit has of its own first, so that a stand-in gives way to them.
  parts.sort(([a], [b]) => Number(kit.roles[a] === undefined) - Number(kit.roles[b] === undefined))
  const taken = new Set<string>()
  const notes: Note[] = []
  for (const [role, line] of parts) {
    const stand = STAND_INS[role]
    const pitch = kit.roles[role] ?? (stand ? (kit.roles[stand] ?? (STAND_INS[stand] ? kit.roles[STAND_INS[stand]!] : undefined)) : undefined)
    if (pitch === undefined) continue
    for (let step = 0; step * SIXTEENTH < length; step++) {
      const mark = line[step % line.length]
      if (mark === '-' || taken.has(`${pitch}:${step}`)) continue
      taken.add(`${pitch}:${step}`)
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
