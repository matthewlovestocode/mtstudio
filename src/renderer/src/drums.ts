/**
 * What the step sequencer knows about drums: which note is which sound in a
 * kit, a set of rhythms to start from, and ways to vary one. Everything here
 * works in notes of a MIDI clip; the sequencer is a way of writing them.
 */
import { DRUM_NAMES, newId, PPQ, type MidiClip, type Note, type Track } from '@shared/model'
import { DRUM_BANK } from './soundfont'

/** The parts of a kit a rhythm is written for. */
export type Role = 'kick' | 'snare' | 'clap' | 'rim' | 'hat' | 'open' | 'tomLow' | 'tomHigh' | 'crash' | 'ride' | 'cowbell' | 'shaker' | 'congaHigh' | 'congaLow'
  | 'congaMute' | 'bongoHigh' | 'bongoLow' | 'timbaleHigh' | 'timbaleLow' | 'claves' | 'agogoHigh' | 'agogoLow' | 'cabasa' | 'guiro' | 'tambourine'

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
  65: 'Timbale high', 66: 'Timbale low', 67: 'Agogo high', 68: 'Agogo low', 58: 'Vibraslap', 69: 'Cabasa', 70: 'Maracas', 71: 'Whistle', 72: 'Whistle long', 73: 'Guiro', 74: 'Guiro long', 75: 'Claves', 76: 'Wood block high',
  77: 'Wood block low', 78: 'Cuica mute', 79: 'Cuica', 80: 'Triangle mute', 81: 'Triangle'
}

const GM_KIT: Kit = {
  roles: { kick: 36, snare: 38, clap: 39, rim: 37, hat: 42, open: 46, tomLow: 45, tomHigh: 50, crash: 49, ride: 51, cowbell: 56, shaker: 70, congaHigh: 63, congaLow: 64,
    congaMute: 62, bongoHigh: 60, bongoLow: 61, timbaleHigh: 65, timbaleLow: 66, claves: 75, agogoHigh: 67, agogoLow: 68, cabasa: 69, guiro: 73, tambourine: 54
  },
  names: GM_NAMES,
  rows: [49, 51, 46, 42, 39, 38, 50, 45, 36]
}

/** The engine's own drum machine has twelve sounds, one to each note name, in the octave from C2. */
const BUILT_IN_KIT: Kit = {
  roles: { kick: 36, snare: 38, clap: 39, rim: 37, hat: 42, open: 46, tomLow: 41, tomHigh: 45, cowbell: 47 },
  names: Object.fromEntries(DRUM_NAMES.map((name, i) => [36 + i, name])),
  rows: [46, 42, 39, 38, 37, 45, 41, 36]
}

/** Sounds a SoundFont kit is silent on, by the kit's name: its patterns play those parts on the nearest thing it has. */
const KIT_GAPS: Record<string, Role[]> = { 'TR-808': ['timbaleHigh', 'timbaleLow'] }
const gapped = new Map<string, Kit>()

export function kitFor(track: Track): Kit {
  if ((track.instrument ?? 'synth') === 'drums') return BUILT_IN_KIT
  const name = track.instrument === 'soundfont' ? (track.soundfont?.name ?? '') : ''
  const gaps = KIT_GAPS[name]
  if (!gaps) return GM_KIT
  let kit = gapped.get(name)
  if (!kit) {
    const silent = new Set(gaps.map((role) => GM_KIT.roles[role]))
    kit = {
      roles: Object.fromEntries(Object.entries(GM_KIT.roles).filter(([role]) => !gaps.includes(role as Role))),
      names: Object.fromEntries(Object.entries(GM_NAMES).filter(([pitch]) => !silent.has(Number(pitch)))),
      rows: GM_KIT.rows
    }
    gapped.set(name, kit)
  }
  return kit
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
 * one bar (16) or two (32) long. `patternNotes` makes a part of them.
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
  Detroit: ['Techno', 'Electro', 'Ghettotech', 'House'],
  Dancehall: ['Basics', 'Modern', 'Trap dancehall', 'Digital and old school', '90s hardcore', 'Hard', 'Percussion', 'Kick and snare', 'Fills and sections']
}

/**
 * The SoundFont drum kit each style belongs on, by the kit's name; a style
 * not listed is at home on the standard kit. `Style/Group` speaks for one
 * group of a style.
 */
const STYLE_KITS: Record<string, string> = {
  Trap: 'TR-808', Drill: 'TR-808', 'Hip hop': 'TR-808', 'R&B': 'TR-808', 'Bass music': 'TR-808',
  House: 'Electronic', Techno: 'Electronic', Garage: 'Electronic', Detroit: 'Electronic', 'Detroit/Electro': 'TR-808', 'Detroit/Ghettotech': 'TR-808',
  Reggaeton: 'Power', Dancehall: 'Electronic', 'Dancehall/Trap dancehall': 'TR-808', 'Dancehall/90s hardcore': 'TR-808', Reggae: 'Room', Rock: 'Power', Funk: 'Room', Breakbeat: 'Room'
}
/** Patterns that go against their style. */
const PATTERN_KITS: Record<string, string> = {
  'Boom bap': 'Room', 'Boom bap, heavy': 'Room', 'Boom bap, two bars': 'Room', 'Lo-fi': 'Room', Motown: 'Standard', 'Slow jam': 'Standard',
  Disco: 'Standard', Synthwave: 'Electronic', 'Dance pop': 'Electronic', Dubstep: 'Electronic', 'Future bass': 'Electronic', 'Big beat': 'Power'
}
export const DEFAULT_KIT = 'Standard'

/** The name of the SoundFont drum kit a pattern is at home on. */
export function kitNameFor(pattern: Pattern): string {
  return PATTERN_KITS[pattern.name] ?? STYLE_KITS[`${pattern.style}/${pattern.group}`] ?? STYLE_KITS[pattern.style] ?? DEFAULT_KIT
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
      tambourine: '----x-------x---',
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
      timbaleHigh: '-----------------------------xx-',
      timbaleLow: '-------------------------------x',
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
      timbaleHigh: '-------------xx-',
      open: '--x---x---x---x-',
      snare: '---x--x----x--x-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Dancehall',
    style: 'Dancehall',
    group: 'Basics',
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
    group: 'Basics',
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
    group: 'Basics',
    bpm: '95–110',
    parts: {
      clap: 'x--x--x-x--x--x-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, digital',
    style: 'Dancehall',
    group: 'Digital and old school',
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
    group: 'Fills and sections',
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
      tambourine: 'x-x-x-x-x-x-x-x-',
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
      claves: 'x--x--x---x-x---',
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
      claves: 'x--x--x---x-x---',
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
      tambourine: '--x---x---x---x-',
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
      claves: 'x--x--x-x--x--x-',
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
    group: 'Basics',
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
    group: 'Basics',
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
      timbaleHigh: '------x-------x-',
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
      claves: 'x--x--x---x-x---',
      kick: '------x-------x-'
    }
  },
  {
    name: 'Rumba clave',
    style: 'Latin',
    bpm: '85–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      claves: 'x--x---x--x-x---',
      kick: '------x-------x-'
    }
  },
  {
    name: 'Salsa',
    style: 'Latin',
    bpm: '85–110',
    parts: {
      bongoLow: '--------------x-',
      bongoHigh: 'x-o-x-o-x-o-x---',
      cowbell: 'x---x-x-x---x-x-',
      ride: 'x-x-xx-xx-xx-x-x',
      claves: '--x-x---x--x--x-',
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
      agogoLow: '--x---x-x-----x-',
      agogoHigh: 'x---x-----x-x---',
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
      guiro: 'x-xxx-xxx-xxx-xx',
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
      cowbell: 'x---x---x---x---',
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
      congaLow: '------x-------xx',
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
      claves: '---x-----x----x-------x--x------',
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
      timbaleHigh: '--------------x-',
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
      timbaleHigh: '--------------x-',
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
      cabasa: 'xoxoxoxoxoxoxoxo',
      bongoHigh: '------x-------x-',
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
      timbaleHigh: '------x-------x-',
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
      guiro: 'x-xxx-xxx-xxx-xx',
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
      guiro: 'x-xxx-xxx-xxx-xx',
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
      guiro: 'x-x-x-x-x-x-x-x-',
      bongoHigh: 'x-x-xx-xx-x-xx-x',
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
      timbaleHigh: '------x-------x-',
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
      congaMute: '----x-------x---',
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
      claves: '---x--x----x-x--',
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
      tambourine: '----x-------x---',
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
      congaMute: 'x---------x-----',
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
  },
  {
    name: 'Dancehall, modern',
    style: 'Dancehall',
    group: 'Modern',
    bpm: '95–105',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      rim: '---x-------x----',
      clap: '------X-------X-',
      kick: 'X-------X--x----'
    }
  },
  {
    name: 'Dancehall, melodic',
    style: 'Dancehall',
    group: 'Modern',
    bpm: '90–100',
    parts: {
      open: '------x---------',
      hat: 'x-x-x-x-x-x-x-3-',
      rim: '---x--x----x--x-',
      kick: 'X-------X-----x-'
    }
  },
  {
    name: 'Dancehall, summer',
    style: 'Dancehall',
    group: 'Modern',
    bpm: '98–108',
    parts: {
      shaker: 'xoxoxoxoxoxoxoxo',
      clap: '---x--x----x--x-',
      kick: 'X--x----X--x----'
    }
  },
  {
    name: 'Dancehall, slow wine',
    style: 'Dancehall',
    group: 'Modern',
    bpm: '85–95',
    parts: {
      shaker: 'o-x-o-x-o-x-o-x-',
      congaHigh: '------x-------x-',
      rim: '---x--x----x--x-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, street',
    style: 'Dancehall',
    group: 'Modern',
    bpm: '95–105',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---X--X----X--X-',
      kick: 'X-----x-X--x----'
    }
  },
  {
    name: 'Dancehall, uptempo',
    style: 'Dancehall',
    group: 'Modern',
    bpm: '105–115',
    parts: {
      hat: 'xxxxxxxxxxxxxxxx',
      snare: '---x--x----x--x-',
      kick: 'X--x--x-X--x----'
    }
  },
  {
    name: 'Dancehall, afro',
    style: 'Dancehall',
    group: 'Modern',
    bpm: '100–108',
    parts: {
      shaker: 'xoxoxoxoxoxoxoxo',
      rim: '---x--x----x--x-',
      clap: '----x-------x---',
      kick: 'X-----x-X---x---'
    }
  },
  {
    name: 'Dancehall, pop',
    style: 'Dancehall',
    group: 'Modern',
    bpm: '95–105',
    parts: {
      hat: '--x---x---x---x-',
      clap: '----X-------X---',
      kick: 'X--x--x-X--x--x-'
    }
  },
  {
    name: 'Dancehall, moody',
    style: 'Dancehall',
    group: 'Modern',
    bpm: '88–98',
    parts: {
      hat: 'x---x---x---x-x-',
      rim: '---x--x----x--x-',
      kick: 'X---------x-----'
    }
  },
  {
    name: 'Trap dancehall',
    style: 'Dancehall',
    group: 'Trap dancehall',
    bpm: '95–105',
    parts: {
      hat: 'x-x-x-x-x-x-x-3-x-x-x-x-x-3-x-4-',
      snare: '---x--x----x--x----x--x----x--x-',
      kick: 'X-------X--x----X-------X-x-----'
    }
  },
  {
    name: 'Trap dancehall, dark',
    style: 'Dancehall',
    group: 'Trap dancehall',
    bpm: '92–102',
    parts: {
      open: '--------------x---------------x-',
      hat: 'x-x-x-3-x-x-x-x-x-x-x-x-3-x-x-x-',
      rim: '---x--x----x--x----x--x----x--x-',
      kick: 'X-----x-X-------X-----x-X--x--x-'
    }
  },
  {
    name: 'Trap dancehall, bouncy',
    style: 'Dancehall',
    group: 'Trap dancehall',
    bpm: '95–105',
    parts: {
      hat: 'xxx-x-x-xxx-x-x-xxx-x-x-x-3-4-x-',
      clap: '------X-------X-------X-------X-',
      kick: 'X--x----X--x----X--x----X--x--x-'
    }
  },
  {
    name: 'Trap dancehall, sparse',
    style: 'Dancehall',
    group: 'Trap dancehall',
    bpm: '90–100',
    parts: {
      hat: '--x---x---x---x---x---x---x---x-',
      clap: '---x--x----x--x----x--x----x--x-',
      kick: 'X---------------X-------x-------'
    }
  },
  {
    name: 'Trap dancehall, heavy 808',
    style: 'Dancehall',
    group: 'Trap dancehall',
    bpm: '95–105',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '---X--X----X--X----X--X----X--X-',
      kick: 'X--x--x-X-----x-X--x--x-X--x-x--'
    }
  },
  {
    name: 'Trap dancehall, triplet hats',
    style: 'Dancehall',
    group: 'Trap dancehall',
    bpm: '95–105',
    parts: {
      hat: 'x-3-x-3-x-3-x-3-x-3-x-3-x-4-x-33',
      snare: '---x--x----x--x----x--x----x--x-',
      kick: 'X-------X-----x-X-----x-X-------'
    }
  },
  {
    name: 'Trap dancehall, fast hats',
    style: 'Dancehall',
    group: 'Trap dancehall',
    bpm: '95–105',
    parts: {
      hat: 'xxxxxxxxxxxxxx3-xxxxxxxxxxxx4-33',
      clap: '---x--x----x--x----x--x----x--x-',
      kick: 'X-------X--x----X--x----X-------'
    }
  },
  {
    name: 'Trap dancehall, rim',
    style: 'Dancehall',
    group: 'Trap dancehall',
    bpm: '92–102',
    parts: {
      hat: 'x-x-x-x-x-x-3-x-x-x-x-x-x-x-x-4-',
      rim: '---x--x--x-x--x----x--x----x-xx-',
      kick: 'X-------X-------X-----x-X-------'
    }
  },
  {
    name: 'Dancehall, computer',
    style: 'Dancehall',
    group: 'Digital and old school',
    bpm: '85–100',
    parts: {
      cowbell: 'x---x---x---x---',
      hat: 'xxxxxxxxxxxxxxxx',
      snare: '------X-------X-',
      kick: 'X--x----X--x----'
    }
  },
  {
    name: 'Dancehall, 80s',
    style: 'Dancehall',
    group: 'Digital and old school',
    bpm: '80–95',
    parts: {
      hat: 'xoxoxoxoxoxoxoxo',
      clap: '----X-------X---',
      kick: 'X--x--x-X--x--x-'
    }
  },
  {
    name: 'Dancehall, 90s',
    style: 'Dancehall',
    group: 'Digital and old school',
    bpm: '95–110',
    parts: {
      hat: '--x---x---x---x-',
      snare: '---x--x----x--x-',
      kick: 'X--x----X--x----'
    }
  },
  {
    name: 'Dancehall, 90s ragga',
    style: 'Dancehall',
    group: 'Digital and old school',
    bpm: '95–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '------X-------X-',
      kick: 'X--x--x-X--x--x-'
    }
  },
  {
    name: 'Dancehall, 2000s',
    style: 'Dancehall',
    group: 'Digital and old school',
    bpm: '100–115',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      tomLow: '----------x--x--',
      clap: '---x--x----x--x-',
      kick: 'X-----x-X-----x-'
    }
  },
  {
    name: 'Dancehall, hand claps',
    style: 'Dancehall',
    group: 'Digital and old school',
    bpm: '100–115',
    parts: {
      tambourine: '--x---x---x---x-',
      clap: 'x--x--x-x--x--xx',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, rolling snare',
    style: 'Dancehall',
    group: 'Digital and old school',
    bpm: '95–110',
    parts: {
      snare: 'X--xo-X-o--xo-X-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Bashment',
    style: 'Dancehall',
    group: 'Hard',
    bpm: '100–110',
    parts: {
      hat: 'xxxxxxxxxxxxxxxx',
      clap: '------X-------X-',
      snare: '---x-------x----',
      kick: 'X--x--x-X--x--x-'
    }
  },
  {
    name: 'Dancehall, hard',
    style: 'Dancehall',
    group: 'Hard',
    bpm: '98–108',
    parts: {
      hat: 'xoxoxoxoxoxoxoxo',
      snare: '---X--X----X--X-',
      kick: 'X--x----X-xx----'
    }
  },
  {
    name: 'Dancehall, clash',
    style: 'Dancehall',
    group: 'Hard',
    bpm: '98–108',
    parts: {
      tomLow: 'x--x--x-x--x--x-',
      snare: '------X-------X-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, stomp',
    style: 'Dancehall',
    group: 'Hard',
    bpm: '100–110',
    parts: {
      open: '--x---x---x---x-',
      clap: '---X--X----X--X-',
      kick: 'X--x--x-X-----x-'
    }
  },
  {
    name: 'Dancehall, timbales',
    style: 'Dancehall',
    group: 'Percussion',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      timbaleHigh: '---x--x----x--x-',
      clap: '------------X---',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, congas',
    style: 'Dancehall',
    group: 'Percussion',
    bpm: '90–110',
    parts: {
      congaHigh: '--x--x----x--x--',
      congaLow: '-------x-------x',
      rim: '---x--x----x--x-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, cowbell',
    style: 'Dancehall',
    group: 'Percussion',
    bpm: '90–110',
    parts: {
      cowbell: 'x--x--x-x--x--x-',
      snare: '------X-------X-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, claves',
    style: 'Dancehall',
    group: 'Percussion',
    bpm: '90–110',
    parts: {
      shaker: 'x-x-x-x-x-x-x-x-',
      claves: '---x--x----x--x-',
      kick: 'X--x----X--x----'
    }
  },
  {
    name: 'Dancehall, shaker',
    style: 'Dancehall',
    group: 'Percussion',
    bpm: '90–110',
    parts: {
      shaker: 'XoxoXoxoXoxoXoxo',
      rim: '---x--x----x--x-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, tambourine',
    style: 'Dancehall',
    group: 'Percussion',
    bpm: '90–110',
    parts: {
      tambourine: '--x---x---x---x-',
      snare: '---x--x----x--x-',
      kick: 'X-----x-X-----x-'
    }
  },
  {
    name: 'Dancehall, rimshot',
    style: 'Dancehall',
    group: 'Percussion',
    bpm: '90–110',
    parts: {
      hat: '--x---x---x---x-',
      rim: '---x--x--x-x--x-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, pushed kick',
    style: 'Dancehall',
    group: 'Kick and snare',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x-',
      kick: 'X-----x-X---x---'
    }
  },
  {
    name: 'Dancehall, double kick',
    style: 'Dancehall',
    group: 'Kick and snare',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x-',
      kick: 'X-x-----X-x-----'
    }
  },
  {
    name: 'Dancehall, late snare',
    style: 'Dancehall',
    group: 'Kick and snare',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '---x---x---x---x',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, half-time',
    style: 'Dancehall',
    group: 'Kick and snare',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '--------X-------',
      kick: 'X--x--x---x--x--'
    }
  },
  {
    name: 'Dancehall, four on the floor',
    style: 'Dancehall',
    group: 'Kick and snare',
    bpm: '100–115',
    parts: {
      hat: '--x---x---x---x-',
      snare: '------X-------X-',
      kick: 'X---X---X---X---'
    }
  },
  {
    name: 'Dancehall, ghost snares',
    style: 'Dancehall',
    group: 'Kick and snare',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: 'o--Xo-X-o--Xo-X-',
      kick: 'X-------X-------'
    }
  },
  {
    name: 'Dancehall, intro',
    style: 'Dancehall',
    group: 'Fills and sections',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      rim: '---x--x----x--x-'
    }
  },
  {
    name: 'Dancehall, break',
    style: 'Dancehall',
    group: 'Fills and sections',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x----x--x----x--x-',
      kick: 'X---------------X---------------'
    }
  },
  {
    name: 'Dancehall, build',
    style: 'Dancehall',
    group: 'Fills and sections',
    bpm: '90–110',
    parts: {
      snare: 'x---x---x---x---x-x-x-x-xxxx2222',
      kick: 'X-------X-------X-------X-------'
    }
  },
  {
    name: 'Dancehall, drop',
    style: 'Dancehall',
    group: 'Fills and sections',
    bpm: '90–110',
    parts: {
      crash: 'X-------------------------------',
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '---X--X----X--X----X--X----X--X-',
      kick: 'X--x----X-------X--x----X-----x-'
    }
  },
  {
    name: 'Dancehall, timbale fill',
    style: 'Dancehall',
    group: 'Fills and sections',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      timbaleHigh: '------------------------x-xx-x--',
      timbaleLow: '------------------------------xx',
      snare: '---x--x----x--x----x--x---------',
      kick: 'X-------X-------X-------X-------'
    }
  },
  {
    name: 'Dancehall, switch-up',
    style: 'Dancehall',
    group: 'Fills and sections',
    bpm: '90–110',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-',
      snare: '---x--x----x--x-------X-------X-',
      kick: 'X-------X-------X--x----X--x--x-'
    }
  },
  {
    name: 'Dancehall, womp',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '92–104',
    parts: {
      hat: '--x---x---x---x-',
      tomLow: '---x-------x----',
      clap: '------X-------X-',
      kick: 'X-x---x-X-x---x-'
    }
  },
  {
    name: 'Dancehall, womp, slow',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '85–95',
    parts: {
      tomLow: '------x-------x-',
      rim: '---x--x----x--x-',
      kick: 'X-x-----X-x-----'
    }
  },
  {
    name: 'Dancehall, womp, double',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '92–104',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      clap: '----X-------X---',
      kick: 'Xx----x-Xx----x-'
    }
  },
  {
    name: 'Dancehall, womp, half-time',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '92–104',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '--------X-------',
      kick: 'X-x-------x-x---'
    }
  },
  {
    name: 'Dancehall, womp, two bars',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '92–104',
    parts: {
      tomLow: '---x-------x-------x-------x--x-',
      clap: '------X-------X-------X-------X-',
      kick: 'X-x---x-X-x---x-X-x---x-X-xx-xx-'
    }
  },
  {
    name: 'Dancehall, 90s hardcore',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '92–104',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      tomLow: '--------------x-',
      clap: '----X-------X---',
      kick: 'X--x--x-X--x--x-'
    }
  },
  {
    name: 'Dancehall, 90s hardcore, bare',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '92–104',
    parts: {
      clap: '----X-------X---',
      kick: 'X--x--x-X--x--x-'
    }
  },
  {
    name: 'Dancehall, 90s hardcore, rim',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '92–104',
    parts: {
      rim: '--x-x--x--x-x--x',
      snare: '----X-------X---',
      kick: 'X--x--x-X-----x-'
    }
  },
  {
    name: 'Dancehall, 90s hip hop',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '88–98',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      snare: '----X-------X---',
      kick: 'X--x--x---x--x--'
    }
  },
  {
    name: 'Dancehall, tom boom',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '92–104',
    parts: {
      tomLow: '---x--x----x--x-',
      clap: '----X-------X---',
      kick: 'X-x-----X-x-----'
    }
  },
  {
    name: 'Dancehall, sound system',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '92–104',
    parts: {
      open: '--------------x-',
      snare: '---x--x----x--x-',
      kick: 'X-----x-X-x---x-'
    }
  },
  {
    name: 'Dancehall, heavy bottom',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '92–104',
    parts: {
      hat: '--x---x---x---x-',
      clap: '------X-------X-',
      kick: 'X-xx--x-X-xx--x-'
    }
  },
  {
    name: 'Dancehall, one two',
    style: 'Dancehall',
    group: '90s hardcore',
    bpm: '92–104',
    parts: {
      hat: 'x-x-x-x-x-x-x-x-',
      clap: '------X-------X-',
      kick: 'X---x---X---x-x-'
    }
  }
]

const SIXTEENTH = PPQ / 4

/** What plays a part on a kit that lacks it. */
const STAND_INS: Partial<Record<Role, Role>> = {
  clap: 'snare', rim: 'snare', crash: 'open', ride: 'hat', open: 'hat', shaker: 'hat', cowbell: 'rim', congaHigh: 'tomHigh', congaLow: 'tomLow',
  congaMute: 'congaHigh', bongoHigh: 'congaHigh', bongoLow: 'congaLow', timbaleHigh: 'tomHigh', timbaleLow: 'tomLow', claves: 'rim',
  agogoHigh: 'cowbell', agogoLow: 'cowbell', cabasa: 'shaker', guiro: 'shaker', tambourine: 'shaker'
}

/** The note that plays a part on a kit: its own, or that of the nearest thing the kit has. */
function pitchOf(kit: Kit, role: Role): number | undefined {
  for (let each: Role | undefined = role, tries = 0; each && tries < 4; each = STAND_INS[each], tries++) {
    const pitch = kit.roles[each]
    if (pitch !== undefined) return pitch
  }
  return undefined
}

// ── From a pattern to a part ─────────────────────────────────────────────

/** How a style ends a phrase and builds from one to the next. */
type Family = 'rolls' | 'toms' | 'timbales' | 'machine'
const FAMILIES: Record<string, Family> = {
  Trap: 'rolls', Drill: 'rolls', 'Hip hop': 'rolls', 'R&B': 'rolls', 'Bass music': 'rolls',
  Reggaeton: 'timbales', Dancehall: 'timbales', Latin: 'timbales', Caribbean: 'timbales', Afro: 'timbales', 'Dancehall/Trap dancehall': 'rolls',
  House: 'machine', Techno: 'machine', Garage: 'machine', Detroit: 'machine'
}

/** How late the steps between the half-beats are played, from 0 to 1 of the sequencer's swing, by style and by pattern. */
export const SWING: Record<string, number> = {
  'Hip hop': 0.16, 'R&B': 0.14, Garage: 0.38, Funk: 0.12, House: 0.1, Reggae: 0.18, 'Boom bap': 0.34, 'Boom bap, heavy': 0.34, 'Boom bap, two bars': 0.34,
  'Lo-fi': 0.4, 'New jack swing': 0.5, 'Go-go': 0.4, 'Detroit house, raw': 0.24, Beatdown: 0.3, 'Detroit techno, shuffled hats': 0.2, 'G-funk': 0.24, Grime: 0
}

/** Parts that run through the bar, and so are played with the beat leaning on them. */
const RUNNING = new Set<Role>(['hat', 'shaker', 'ride', 'cabasa', 'guiro', 'tambourine'])
/** Parts a fill plays over. */
const TOPS: Role[] = ['hat', 'open', 'shaker', 'ride', 'cabasa', 'guiro', 'tambourine', 'rim', 'cowbell']
/** A pattern that is already an event (a fill, a build, a break) is played as written. */
const AS_WRITTEN = /fill|build|drop|roll|rush|break|intro|come in|switch|drops out/i

const BAR = 16

/** Random numbers that are the same every time for the same word, so a pattern always comes out the same. */
export function seeded(word: string): () => number {
  let state = 2166136261
  for (let i = 0; i < word.length; i++) state = Math.imul(state ^ word.charCodeAt(i), 16777619)
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A pattern laid out over `steps` sixteenths, a line to a part, and made to
 * go somewhere. Over four bars the second bar answers the first with a small
 * change and the fourth ends in a fill; over eight the second four are
 * fuller (a cymbal or a bell joins, a crash marks the turn) and end in a
 * bigger fill. What a fill and a lift are depends on the style. Shorter
 * than two bars, the pattern is just repeated.
 */
function arrange(pattern: Pattern, steps: number): Map<Role, string[]> {
  const grid = new Map<Role, string[]>()
  for (const [role, line] of Object.entries(pattern.parts) as [Role, string][]) grid.set(role, Array.from({ length: steps }, (_, step) => line[step % line.length]))
  const bars = Math.floor(steps / BAR)
  if (bars < 2 || AS_WRITTEN.test(pattern.name)) return grid

  const random = seeded(pattern.name)
  const family = FAMILIES[`${pattern.style}/${pattern.group}`] ?? FAMILIES[pattern.style] ?? 'toms'
  const line = (role: Role): string[] => {
    if (!grid.has(role)) grid.set(role, Array.from({ length: steps }, () => '-'))
    return grid.get(role)!
  }
  const put = (role: Role, step: number, mark: string): void => {
    if (step < steps) line(role)[step] = mark
  }
  const clear = (roles: Role[], from: number, to: number): void => {
    for (const role of roles) if (grid.has(role)) for (let step = from; step < to && step < steps; step++) grid.get(role)![step] = '-'
  }
  const has = (role: Role): boolean => role in pattern.parts
  const oneBar = Object.values(pattern.parts).every((each) => each!.length <= BAR)
  // The backbeat's voice, for answers and fills: whichever of these the pattern is built on.
  const back: Role = has('snare') ? 'snare' : has('clap') ? 'clap' : has('rim') ? 'rim' : 'snare'

  // The answer: one small change, the same one each time it comes round.
  const answers: ((bar: number) => void)[] = [
    (bar) => {
      const free = [7, 10, 11, 14, 15].filter((step) => line('kick')[bar * BAR + step] === '-')
      if (free.length) put('kick', bar * BAR + free[Math.floor(random() * free.length)], 'x')
    },
    (bar) => {
      const free = [7, 9, 15].filter((step) => line(back)[bar * BAR + step] === '-')
      if (free.length) put(back, bar * BAR + free[Math.floor(random() * free.length)], 'o')
    },
    (bar) => {
      if (has('hat')) put('hat', bar * BAR + 14, '-')
      put('open', bar * BAR + 14, 'x')
    }
  ]
  const answer = answers[Math.floor(random() * answers.length)]
  const spot = Math.floor(random() * 3)

  for (let bar = 0; bar < bars; bar++) {
    const at = bar * BAR
    const place = bar % 4
    const second = Math.floor(bar / 4) % 2 === 1
    const last = bar === bars - 1

    // The second four bars are fuller.
    if (second) {
      if (place === 0) put('crash', at, 'X')
      if (family === 'toms' && has('hat') && !has('ride')) {
        for (let step = at; step < at + BAR; step++) {
          put('ride', step, line('hat')[step])
          put('hat', step, '-')
        }
      } else if (family === 'timbales' && !has('cowbell')) for (const step of [0, 4, 8, 12]) put('cowbell', at + step, step === 0 ? 'x' : 'o')
      else if (family === 'machine' && !has('ride')) for (const step of [2, 6, 10, 14]) put(has('open') ? 'ride' : 'open', at + step, 'x')
      else if (family === 'rolls' && has('hat') && place % 2 === 0 && line('hat')[at + 6] === 'x') put('hat', at + 6, random() < 0.5 ? '2' : '3')
    }

    // Bars two and four answer bars one and three, where the pattern does not already.
    if (oneBar && place % 2 === 1) answer(bar)

    // A phrase ends in a fill: a small one after four bars, a bigger one after eight, and at the end of the clip the one it has earned.
    const ends = place === 3 || (last && bars >= 2 && place === 1)
    if (!ends) continue
    const big = second && place === 3
    const from = at + (big ? 8 : 12)
    if (family === 'rolls') {
      // The hats break into rolls, and a big one hands over to the snare.
      const shapes = [['x', '3', 'x', '4'], ['2', 'x', '3', '3'], ['x', 'x', '2', '4']]
      shapes[spot].forEach((mark, i) => put('hat', at + 12 + i, mark))
      if (big) {
        clear(['hat', 'open', 'kick'], at + 12, at + BAR)
        ;['x', '2', '3', '4'].forEach((mark, i) => put(back === 'clap' ? 'snare' : back, at + 12 + i, mark))
        put('open', at + 10, 'x')
      }
    } else if (family === 'timbales') {
      // Timbales over the top; the kick and the snare keep the dance going underneath.
      const shapes: [Role, number, string][][] = [
        [['timbaleHigh', 13, 'x'], ['timbaleHigh', 14, 'x'], ['timbaleLow', 15, 'X']],
        [['timbaleHigh', 12, 'x'], ['timbaleHigh', 14, '2'], ['timbaleLow', 15, 'X']],
        [['timbaleHigh', 13, '2'], ['timbaleLow', 14, 'x'], ['timbaleLow', 15, 'X']]
      ]
      if (big) for (const [role, step, mark] of [['timbaleHigh', 8, 'x'], ['timbaleHigh', 10, 'x'], ['timbaleHigh', 11, 'x']] as [Role, number, string][]) put(role, at + step, mark)
      for (const [role, step, mark] of shapes[spot]) put(role, at + step, mark)
    } else if (family === 'machine') {
      // The kick steps out and the clap or snare rushes back in.
      clear(['kick'], from, at + BAR)
      const shapes = [['-', '-', 'x', '2'], ['-', 'x', 'x', '2'], ['x', '-', '2', '4']]
      shapes[spot].forEach((mark, i) => mark !== '-' && put(back, at + 12 + i, mark))
      if (big) put(back, at + 10, 'o')
    } else {
      // Round the kit: the snare, then down the toms.
      clear([...TOPS, 'snare', 'clap'], from, at + BAR)
      const shapes: [Role, string][][] = [
        [['snare', 'x'], ['snare', 'x'], ['tomHigh', 'x'], ['tomLow', 'X']],
        [['snare', 'x'], ['-' as Role, '-'], ['snare', '2'], ['tomLow', 'X']],
        [['snare', 'o'], ['snare', 'x'], ['snare', 'x'], ['snare', 'X']]
      ]
      shapes[spot].forEach(([role, mark], i) => mark !== '-' && put(role, at + 12 + i, mark))
      if (big) for (const [step, mark] of [[8, 'x'], [10, 'x'], [11, 'o']] as [number, string][]) put('snare', at + step, mark)
    }
  }
  return grid
}

/**
 * The notes that play a pattern on a kit for `length` ticks, as a drummer
 * would play it: laid out to go somewhere (see `arrange`), the running parts
 * leaning on the beat, each hit a shade louder or softer than the last, and
 * swung where the style is. A part the kit lacks is played by the nearest
 * thing it has (a clap by the snare, a shaker by the hat) or left out;
 * where that would put two hits on one drum at once, the part written for
 * that drum keeps the step. The same pattern always comes out the same.
 */
export function patternNotes(pattern: Pattern, kit: Kit, length: number): Note[] {
  const steps = Math.ceil(length / SIXTEENTH)
  const parts = [...arrange(pattern, steps)]
  // Parts the kit has of its own first, so that a stand-in gives way to them.
  parts.sort(([a], [b]) => Number(kit.roles[a] === undefined) - Number(kit.roles[b] === undefined))
  const random = seeded(`${pattern.name} feel`)
  const late = Math.round((SWING[pattern.name] ?? SWING[pattern.style] ?? 0) * SIXTEENTH * 0.5)
  const taken = new Set<string>()
  const notes: Note[] = []
  for (const [role, line] of parts) {
    const pitch = pitchOf(kit, role)
    if (pitch === undefined) continue
    // A running part written all at one level is given the beat's shape: strongest on the beat, lightest between the half-beats.
    const shaped = RUNNING.has(role) && !/[Xo]/.test(pattern.parts[role] ?? '')
    for (let step = 0; step < steps; step++) {
      const mark = line[step]
      if (mark === '-' || taken.has(`${pitch}:${step}`)) continue
      taken.add(`${pitch}:${step}`)
      const level = mark === 'X' ? ACCENT : mark === 'o' ? GHOST : shaped ? [0.86, 0.56, 0.7, 0.56][step % 4] : NORMAL
      const velocity = Math.min(1, level * (0.94 + random() * 0.12))
      if (mark >= '2' && mark <= '4') notes.push(...hits(pitch, step * SIXTEENTH, SIXTEENTH, velocity, Number(mark)))
      else notes.push(...hits(pitch, step * SIXTEENTH + (step % 2 === 1 ? late : 0), SIXTEENTH, velocity))
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
