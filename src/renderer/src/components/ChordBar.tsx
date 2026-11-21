import { newId, type MidiClip, type Note, type Track } from '@shared/model'
import { PROGRESSIONS, chordPitches, harmonyOf, keyChords, pull, type Chord, type Key, type Progression } from '@shared/theory'
import { engine } from '../engine'
import { findClip, replaceClip } from '../state/actions'
import { useStudio } from '../state/store'
import { Segmented, Toggle } from './controls/buttons'
import { Picker } from './controls/Picker'
import { setLayout, useLayout } from './layout'

const LENGTHS = [
  ['0.5', '½ bar'],
  ['1', '1 bar'],
  ['2', '2 bars']
] as const

/**
 * The chords of the song's key, to hear and to write with. Each button is a
 * chord: clicking it plays it, and its plus adds it to the clip after what
 * is already there, so a progression is built by adding one chord after
 * another. Once there is a chord, the ones that most often follow it are
 * marked. A whole progression can be laid down to start from.
 */
export function ChordBar(props: {
  track: Track
  clip: MidiClip
  songKey: Key
  /** The length of a bar where the clip is, in ticks. */
  barTicks: number
  /** The step of the scale the clip's last chord stands on, if it ends on one of the key's chords: what the suggestions follow from. */
  lastDegree: number | null
}): React.JSX.Element {
  const { track, clip, songKey, barTicks, lastDegree } = props
  const bars = useLayout((s) => s.chordBars)
  const sevenths = useLayout((s) => s.chordSevenths)
  const chords = keyChords(songKey)
  const family = harmonyOf(songKey)

  const play = (chord: Chord): void => {
    const pitches = chordPitches(chord, sevenths)
    for (const pitch of pitches) engine.noteOn(track.id, pitch, 0.75)
    window.setTimeout(() => pitches.forEach((pitch) => engine.noteOff(track.id, pitch)), 700)
  }

  const latest = (): MidiClip => {
    const found = findClip(useStudio.getState().project, clip.id)?.clip
    return found?.kind === 'midi' ? found : clip
  }
  const chordNotes = (chord: Chord, start: number, length: number): Note[] =>
    chordPitches(chord, sevenths).map((pitch) => ({ id: newId(), pitch, start, length, velocity: 0.75 }))
  /** Lengthens the clip to whole bars, if it must be longer to hold what has been written. */
  const fitted = (now: MidiClip, notes: Note[], end: number): MidiClip => ({ ...now, notes, length: Math.max(now.length, Math.ceil(end / barTicks) * barTicks) })

  /** Adds a chord after the last note in the clip, on the next line of the chosen length. */
  const add = (chord: Chord): void => {
    const now = latest()
    const length = Math.round(barTicks * bars)
    const end = now.notes.reduce((latestEnd, note) => Math.max(latestEnd, note.start + note.length), 0)
    const start = Math.ceil(end / length) * length
    replaceClip(fitted(now, [...now.notes, ...chordNotes(chord, start, length)], start + length))
    play(chord)
  }

  /** Lays a progression down from the start of the clip, in place of its notes: one chord to each stretch of the chosen length. */
  const lay = (progression: Progression): void => {
    const length = Math.round(barTicks * bars)
    const notes = progression.degrees.flatMap((degree, i) => chordNotes(chords[degree], i * length, length))
    replaceClip(fitted(latest(), notes, progression.degrees.length * length))
  }

  const offered = PROGRESSIONS.filter((each) => each.family === family)
  const styles = [...new Set(offered.map((each) => each.style))]
  return (
    <div className="cb">
      <span className="pr-label">Chords</span>
      <div className="cb-chords" role="group" aria-label={`Chords of the key`}>
        {chords.map((chord) => {
          const follows = lastDegree === null ? null : pull(songKey, lastDegree, chord.degree)
          return (
            <div key={chord.degree} className={`cb-chord ${follows ?? ''} ${chord.degree === lastDegree ? 'last' : ''}`}>
              <button
                type="button"
                className="cb-play"
                title={`${chord.name} (${chord.numeral}): click to hear it${follows === 'strong' ? '. It follows the last chord strongly.' : follows === 'common' ? '. It often follows the last chord.' : ''}`}
                onClick={() => play(chord)}
              >
                <strong>{chord.name}</strong>
                <span>{chord.numeral}</span>
              </button>
              <button type="button" className="cb-add" title={`Add ${chord.name} to the clip, after what is there`} aria-label={`Add ${chord.name} to the clip`} onClick={() => add(chord)}>
                +
              </button>
            </div>
          )
        })}
      </div>
      <Segmented label="How long an added chord lasts" value={String(bars) as (typeof LENGTHS)[number][0]} options={LENGTHS} onChange={(value) => setLayout({ chordBars: Number(value) })} />
      <Toggle label="Sevenths: add the seventh on top of each chord, for a richer, jazzier sound" size="sm" pressed={sevenths} onChange={(on) => setLayout({ chordSevenths: on })}>
        7th
      </Toggle>
      <span className="pr-space" />
      {family && (
        <div className="cb-picker">
          <Picker
            label="Start from a progression…"
            title="Replace the clip's notes with a run of chords to work from"
            placeholder="Search progressions"
            groups={styles.map((style) => ({
              label: style,
              // With the chords it makes in this key, which is what will be heard; a long one by its numerals.
              options: offered
                .filter((each) => each.style === style)
                .map((each) => ({ value: each, label: each.name, detail: each.degrees.length <= 4 ? each.degrees.map((degree) => chords[degree].name).join(' – ') : each.numerals }))
            }))}
            onPick={lay}
          />
        </div>
      )}
    </div>
  )
}
