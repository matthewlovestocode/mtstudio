/**
 * Keys and scales: which notes belong to a key, the nearest that does, and a
 * guess at the key of some notes. Pitches are MIDI note numbers and pitch
 * classes are 0 to 11 from C, throughout.
 */

/** The scales on offer, as steps in semitones above the root. */
export const SCALES = {
  major: { name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { name: 'Minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  harmonicMinor: { name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  dorian: { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  phrygian: { name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  lydian: { name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  mixolydian: { name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  majorPentatonic: { name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  minorPentatonic: { name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  blues: { name: 'Blues', steps: [0, 3, 5, 6, 7, 10] }
} as const

export type ScaleId = keyof typeof SCALES

/** The key a project is in: a root and the scale built on it. */
export interface Key {
  /** The root's pitch class: 0 is C, 9 is A. */
  root: number
  scale: ScaleId
}

const SHARPS = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const FLATS = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B']

/** Scales with a minor third, whose keys take their spelling from the relative major three semitones up. */
const MINORISH: ScaleId[] = ['minor', 'harmonicMinor', 'dorian', 'phrygian', 'minorPentatonic', 'blues']
/** The major keys written with flats; the rest are written with sharps. */
const FLAT_MAJORS = new Set([5, 10, 3, 8, 1, 6])

/** Whether a key's notes are spelled with flats (F major has a B♭, not an A♯). */
export function usesFlats(key: Key | null | undefined): boolean {
  if (!key) return false
  return FLAT_MAJORS.has(MINORISH.includes(key.scale) ? (key.root + 3) % 12 : key.root)
}

const mod12 = (n: number): number => ((n % 12) + 12) % 12

/** A pitch class's name, spelled to suit the key. */
export function pitchClassName(pitchClass: number, key?: Key | null): string {
  return (usesFlats(key) ? FLATS : SHARPS)[mod12(pitchClass)]
}

/** A pitch's name with its octave: 60 is C4. */
export function noteName(pitch: number, key?: Key | null): string {
  return `${pitchClassName(pitch, key)}${Math.floor(pitch / 12) - 1}`
}

export function keyName(key: Key): string {
  return `${pitchClassName(key.root, key)} ${SCALES[key.scale].name.toLowerCase()}`
}

export function inKey(key: Key, pitch: number): boolean {
  return (SCALES[key.scale].steps as readonly number[]).includes(mod12(pitch - key.root))
}

export function isRoot(key: Key, pitch: number): boolean {
  return mod12(pitch - key.root) === 0
}

/**
 * The note of the key nearest a pitch: the pitch itself if it belongs. Where
 * two are equally near, `lean` says which way to go (up if positive).
 */
export function nearestInKey(key: Key, pitch: number, lean = -1): number {
  for (let away = 0; away < 12; away++) {
    const first = lean > 0 ? pitch + away : pitch - away
    const second = lean > 0 ? pitch - away : pitch + away
    if (inKey(key, first)) return first
    if (inKey(key, second)) return second
  }
  return pitch
}

/** Moves a pitch a number of steps up or down the key's scale. A pitch outside the key first goes to the nearest note in it, in that direction. */
export function stepInKey(key: Key, pitch: number, steps: number): number {
  const direction = Math.sign(steps)
  let at = inKey(key, pitch) ? pitch : nearestInKey(key, pitch, direction)
  // Arriving at the scale from outside it is itself the first step.
  let left = Math.abs(steps) - (at === pitch ? 0 : 1)
  while (left > 0) {
    at += direction
    if (inKey(key, at)) left--
  }
  return at
}

// ── Guessing the key ─────────────────────────────────────────────────────

/**
 * How much each note of the scale is heard in music in a major or a minor
 * key, from the root up: the Krumhansl-Kessler profiles, the usual basis for
 * finding a key from its notes.
 */
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

function correlation(a: number[], b: number[]): number {
  const mean = (list: number[]): number => list.reduce((sum, n) => sum + n, 0) / list.length
  const ma = mean(a)
  const mb = mean(b)
  let top = 0
  let da = 0
  let db = 0
  for (let i = 0; i < a.length; i++) {
    top += (a[i] - ma) * (b[i] - mb)
    da += (a[i] - ma) ** 2
    db += (b[i] - mb) ** 2
  }
  return da && db ? top / Math.sqrt(da * db) : 0
}

export interface KeyGuess {
  key: Key
  /** How well the notes fit, -1 to 1. Above about 0.6 is a confident fit. */
  fit: number
}

/**
 * The major and minor keys that best fit some notes, best first. Each note
 * counts for as long as it lasts. Empty if there is too little to go on:
 * fewer than three different notes.
 */
export function guessKeys(notes: { pitch: number; length: number }[]): KeyGuess[] {
  const heard = new Array<number>(12).fill(0)
  for (const note of notes) heard[mod12(note.pitch)] += Math.max(1, note.length)
  if (heard.filter((amount) => amount > 0).length < 3) return []
  const guesses: KeyGuess[] = []
  for (let root = 0; root < 12; root++) {
    // The profile is from the root up, so the notes are turned to start from the root too.
    const fromRoot = heard.map((_, i) => heard[(i + root) % 12])
    guesses.push({ key: { root, scale: 'major' }, fit: correlation(fromRoot, MAJOR_PROFILE) })
    guesses.push({ key: { root, scale: 'minor' }, fit: correlation(fromRoot, MINOR_PROFILE) })
  }
  return guesses.sort((a, b) => b.fit - a.fit)
}

// ── Chords ───────────────────────────────────────────────────────────────

export type Quality = 'maj' | 'min' | 'dim' | 'aug'

/** One of the chords a key is built from: the triad on a step of its scale. */
export interface Chord {
  /** Which step of the scale it stands on, from 0. */
  degree: number
  /** Its root's pitch class. */
  root: number
  quality: Quality
  /** "Am", "F", "B dim". */
  name: string
  /** Its place in the key, as musicians write it: "i", "IV", "vii°", "♭VII". */
  numeral: string
  /** The pitch classes of the triad, and of the seventh that sits on top of it in this key. */
  tones: number[]
  seventh: number
}

const QUALITY_SUFFIX: Record<Quality, string> = { maj: '', min: 'm', dim: ' dim', aug: ' aug' }
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII']
const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11]

/**
 * The seven-note scale a key's chords come from. A pentatonic or blues scale
 * has too few notes to stack chords on, so its chords are those of the major
 * or minor scale it is a part of.
 */
export function chordScale(scale: ScaleId): ScaleId {
  return scale === 'majorPentatonic' ? 'major' : scale === 'minorPentatonic' || scale === 'blues' ? 'minor' : scale
}

/** The chords of a key, from the one on its root upwards: each a step of the scale with the notes two and four steps above it. */
export function keyChords(key: Key): Chord[] {
  const scale = chordScale(key.scale)
  const steps = SCALES[scale].steps
  // In a minor key III, VI and VII are written plain, as everyone reads them; a mode's are marked against the major scale.
  const plain: readonly number[] = scale === 'minor' || scale === 'harmonicMinor' ? steps : MAJOR_STEPS
  return steps.map((step, degree) => {
    const at = (above: number): number => steps[(degree + above) % 7] + (degree + above >= 7 ? 12 : 0)
    const third = at(2) - step
    const fifth = at(4) - step
    const quality: Quality = third === 4 ? (fifth === 8 ? 'aug' : 'maj') : fifth === 6 ? 'dim' : 'min'
    const root = mod12(key.root + step)
    // Where the step differs from the major scale's it is marked flat or sharp; capitals are major chords.
    const off = step - plain[degree]
    const numeral = NUMERALS[degree]
    return {
      degree,
      root,
      quality,
      name: pitchClassName(root, key) + QUALITY_SUFFIX[quality],
      numeral: (off < 0 ? '♭' : off > 0 ? '♯' : '') + (quality === 'maj' || quality === 'aug' ? numeral : numeral.toLowerCase()) + (quality === 'dim' ? '°' : quality === 'aug' ? '+' : ''),
      tones: [root, mod12(root + third), mod12(root + fifth)],
      seventh: mod12(key.root + at(6))
    }
  })
}

/**
 * The notes to play a chord with, in close position with its root nearest
 * `around` (middle C by default), so that one chord after another does not
 * leap about.
 */
export function chordPitches(chord: Chord, withSeventh = false, around = 60): number[] {
  let root = around - mod12(around - chord.root)
  if (around - root > 6) root += 12
  const above = (pitchClass: number): number => root + mod12(pitchClass - chord.root)
  return [root, ...chord.tones.slice(1).map(above), ...(withSeventh ? [above(chord.seventh)] : [])]
}

/** How readily one chord of a key follows another. */
export type Pull = 'strong' | 'common'

/**
 * Where each chord most often goes next, by step of the scale, in a major
 * and in a minor key: the habits of several centuries of harmony, not rules.
 * `strong` are the moves that sound most settled or most expected; `common`
 * are heard nearly as often.
 */
const FOLLOWS: Record<'major' | 'minor', Record<number, { strong: number[]; common: number[] }>> = {
  major: {
    0: { strong: [3, 4, 5], common: [1, 2] },
    1: { strong: [4], common: [6, 3] },
    2: { strong: [5], common: [3, 1] },
    3: { strong: [4, 0], common: [1, 5] },
    4: { strong: [0], common: [5, 3] },
    5: { strong: [1, 3], common: [4, 2] },
    6: { strong: [0], common: [2, 5] }
  },
  minor: {
    0: { strong: [3, 4, 5, 6], common: [2] },
    1: { strong: [4], common: [6] },
    2: { strong: [5, 3], common: [6] },
    3: { strong: [4, 0], common: [6] },
    4: { strong: [0], common: [5] },
    5: { strong: [2, 3, 6], common: [1] },
    6: { strong: [2, 0], common: [5] }
  }
}

/** Which family of habits a key's chords follow; null for the modes, whose own habits are not charted here. */
export function harmonyOf(key: Key): 'major' | 'minor' | null {
  const scale = chordScale(key.scale)
  return scale === 'major' ? 'major' : scale === 'minor' || scale === 'harmonicMinor' ? 'minor' : null
}

/** How readily the chord on step `to` follows the one on step `from` in this key; null if it is not a usual move, or the key is a mode. */
export function pull(key: Key, from: number, to: number): Pull | null {
  const family = harmonyOf(key)
  const habits = family && FOLLOWS[family][from]
  if (!habits) return null
  return habits.strong.includes(to) ? 'strong' : habits.common.includes(to) ? 'common' : null
}

/** A run of chords to start from, as steps of the scale (from 0), one chord to a bar. */
export interface Progression {
  name: string
  /** As it is written: "I – V – vi – IV". */
  numerals: string
  degrees: number[]
  family: 'major' | 'minor'
  /** Where it is at home. */
  style: string
}

export const PROGRESSIONS: Progression[] = [
  { name: 'The four chords', numerals: 'I – V – vi – IV', degrees: [0, 4, 5, 3], family: 'major', style: 'Pop' },
  { name: 'Sensitive', numerals: 'vi – IV – I – V', degrees: [5, 3, 0, 4], family: 'major', style: 'Pop' },
  { name: 'Fifties', numerals: 'I – vi – IV – V', degrees: [0, 5, 3, 4], family: 'major', style: 'Pop' },
  { name: 'Three chords', numerals: 'I – IV – V – IV', degrees: [0, 3, 4, 3], family: 'major', style: 'Rock' },
  { name: 'Two five one', numerals: 'ii – V – I – I', degrees: [1, 4, 0, 0], family: 'major', style: 'Jazz' },
  { name: 'Rising', numerals: 'I – iii – IV – V', degrees: [0, 2, 3, 4], family: 'major', style: 'Pop' },
  { name: 'Canon', numerals: 'I – V – vi – iii – IV – I – IV – V', degrees: [0, 4, 5, 2, 3, 0, 3, 4], family: 'major', style: 'Classical' },
  { name: 'Twelve-bar blues', numerals: 'I I I I – IV IV I I – V IV I V', degrees: [0, 0, 0, 0, 3, 3, 0, 0, 4, 3, 0, 4], family: 'major', style: 'Blues' },
  { name: 'One drop', numerals: 'I – IV', degrees: [0, 3], family: 'major', style: 'Reggae' },
  { name: 'Epic', numerals: 'i – VI – III – VII', degrees: [0, 5, 2, 6], family: 'minor', style: 'Pop, reggaeton' },
  { name: 'Dark loop', numerals: 'i – VI – VII – i', degrees: [0, 5, 6, 0], family: 'minor', style: 'Trap' },
  { name: 'Two chords', numerals: 'i – VI', degrees: [0, 5], family: 'minor', style: 'Trap' },
  { name: 'Andalusian', numerals: 'i – VII – VI – V', degrees: [0, 6, 5, 4], family: 'minor', style: 'Flamenco, reggaeton' },
  { name: 'Minor three chords', numerals: 'i – iv – v – i', degrees: [0, 3, 4, 0], family: 'minor', style: 'Rock' },
  { name: 'Falling', numerals: 'i – VII – VI – VII', degrees: [0, 6, 5, 6], family: 'minor', style: 'Rock, dancehall' },
  { name: 'Yearning', numerals: 'i – iv – VII – III', degrees: [0, 3, 6, 2], family: 'minor', style: 'Pop' },
  { name: 'Minor two five one', numerals: 'ii° – v – i – i', degrees: [1, 4, 0, 0], family: 'minor', style: 'Jazz' },
  { name: 'Riddim', numerals: 'i – VII', degrees: [0, 6], family: 'minor', style: 'Dancehall, reggae' }
]

// ── Naming a chord from its notes ────────────────────────────────────────

const SHAPES: [string, number[]][] = [
  ['', [0, 4, 7]],
  ['m', [0, 3, 7]],
  [' dim', [0, 3, 6]],
  [' aug', [0, 4, 8]],
  ['sus4', [0, 5, 7]],
  ['sus2', [0, 2, 7]]
]

export interface NamedChord {
  root: number
  name: string
  /** The triad's pitch classes. */
  tones: number[]
}

/**
 * The chord some notes make, if they make one: `heard` is how much of each
 * pitch class there is (by time, say), and `lowest` the pitch class of the
 * lowest note, which settles ties, since the same notes are a different
 * chord over a different bass. Null unless all three notes of some triad
 * are there.
 */
export function nameChord(heard: number[], lowest: number | null, key?: Key | null): NamedChord | null {
  let best: { score: number; root: number; suffix: string; tones: number[] } | null = null
  const total = heard.reduce((sum, amount) => sum + amount, 0)
  if (!total) return null
  for (let root = 0; root < 12; root++) {
    for (const [suffix, shape] of SHAPES) {
      const tones = shape.map((step) => (root + step) % 12)
      if (tones.some((tone) => heard[tone] <= 0)) continue
      const inside = tones.reduce((sum, tone) => sum + heard[tone], 0)
      // Notes of the chord count for it, others against it; the plain triads are preferred to the suspended ones, and a root in the bass to any other.
      const score = inside - (total - inside) * 0.6 + (root === lowest ? total * 0.25 : 0) - (suffix.startsWith('sus') ? total * 0.15 : 0)
      if (!best || score > best.score) best = { score, root, suffix, tones }
    }
  }
  if (!best) return null
  // A seventh on top is named when it is there in earnest, not in passing.
  const share = (step: number): number => heard[(best!.root + step) % 12] / total
  const seventh = best.suffix.startsWith('sus') || best.suffix === ' aug' ? '' : share(10) > 0.12 ? '7' : share(11) > 0.12 ? 'maj7' : ''
  const suffix = seventh === 'maj7' && best.suffix === '' ? 'maj7' : seventh === '7' && best.suffix === ' dim' ? 'm7♭5' : best.suffix + seventh
  return { root: best.root, name: pitchClassName(best.root, key) + suffix, tones: best.tones }
}

// ── Keys that sit near one another ───────────────────────────────────────

const pitchClasses = (key: Key): Set<number> => new Set(SCALES[chordScale(key.scale)].steps.map((step) => mod12(key.root + step)))

/** How many of the notes of one key are also in another: seven for keys with the same notes, fewer the further apart they are. */
export function sharedNotes(a: Key, b: Key): number {
  const other = pitchClasses(b)
  return [...pitchClasses(a)].filter((pitchClass) => other.has(pitchClass)).length
}

export interface RelatedKey {
  key: Key
  /** Why it is worth considering, in a few words. */
  why: string
}

/**
 * Keys a song in `key` can move to without the change jarring, nearest
 * first: those that share nearly all its notes, the one on the same root,
 * and the step up that a last chorus takes. Offered for major and minor
 * keys; a mode is treated as the major or minor key it most resembles.
 */
export function relatedKeys(key: Key): RelatedKey[] {
  const minor = MINORISH.includes(key.scale)
  const here: ScaleId = minor ? 'minor' : 'major'
  const there: ScaleId = minor ? 'major' : 'minor'
  const at = (semitones: number, scale: ScaleId): Key => ({ root: mod12(key.root + semitones), scale })
  const shares = (other: Key): string => `${sharedNotes({ ...key, scale: here }, other)} of its 7 notes are the same`
  const relative = at(minor ? 3 : 9, there)
  const fifthUp = at(7, here)
  const fifthDown = at(5, here)
  return [
    { key: relative, why: 'the same notes, with a brighter or darker home' },
    { key: fifthUp, why: `a fifth up: ${shares(fifthUp)}` },
    { key: fifthDown, why: `a fifth down: ${shares(fifthDown)}` },
    { key: at(0, there), why: 'the same home note, major swapped for minor' },
    { key: at(minor ? 10 : 4, there), why: `${shares(at(minor ? 10 : 4, there))}` },
    { key: at(minor ? 8 : 2, there), why: `${shares(at(minor ? 8 : 2, there))}` },
    { key: at(2, here), why: 'a whole step up: a lift, often for a last chorus' },
    { key: at(1, here), why: 'a half step up: a bolder lift' }
  ]
}
