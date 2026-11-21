import { useEffect, useRef, useState } from 'react'
import { DRUM_NAMES, newId, PPQ, type MidiClip, type Note, type Track } from '@shared/model'
import { keySegments, segmentAt } from '@shared/keymap'
import { inKey, isRoot, nearestInKey, noteName, type Key } from '@shared/theory'
import { timeMap } from '@shared/timemap'
import { TextField } from './controls/fields'
import { PARTS, headingOf, partNotes, partOrder, roomFor, type Part } from '../parts'
import { isDrumTrack } from '../drums'
import { engine } from '../engine'
import { barChords } from '../harmony'
import { addNote, fixNotesToKey, replaceClip, quantiseNotes, removeNotes, stepNotesInKey, transposeNotes, updateClip, updateNote, updateNotes } from '../state/actions'
import { useStudio } from '../state/store'
import { isBlackKey, pitchName, snapTo, startDrag, useFrame } from '../util'
import { Button, IconButton, Segmented, Toggle } from './controls/buttons'
import { ChordBar } from './ChordBar'
import { KeyPicker } from './KeyPicker'
import { Picker } from './controls/Picker'
import { useMenu } from './controls/Popover'
import { ROLL_ZOOM, setLayout, useLayout } from './layout'

const ROW_HEIGHT = 14
const LOW = 24 // C1
const HIGH = 107 // B7
const VELOCITY_HEIGHT = 60
/** The note grids on offer, as a label and a number of ticks. */
const SNAP_OPTIONS: [string, number][] = [
  ['1/4', PPQ],
  ['1/8', PPQ / 2],
  ['1/16', PPQ / 4],
  ['1/32', PPQ / 8]
]
const PITCHES = Array.from({ length: HIGH - LOW + 1 }, (_, i) => HIGH - i)
const GRIDS = SNAP_OPTIONS.map(([label, ticks]) => [String(ticks), label] as const)

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

/**
 * The editor for a MIDI clip. Click the grid to draw a note and drag notes to
 * move or resize them; with Shift or Cmd/Ctrl held, a drag over the grid
 * draws a box that selects the notes it touches. The ruler moves the
 * playhead, the toolbar's tools act on the selection (or on every note when
 * there is none), and a right-click offers the same and more.
 */
export function PianoRoll({ track, clip, viewSwitch }: { track: Track; clip: MidiClip; /** The switch between this and the step sequencer, which the clip editor supplies. */ viewSwitch?: React.ReactNode }): React.JSX.Element {
  const snap = useStudio((s) => s.snap)
  const selectedNoteIds = useStudio((s) => s.selectedNoteIds)
  // The tools act on the selected notes, or on every note when none is selected.
  const selected = selectedNoteIds.filter((id) => clip.notes.some((n) => n.id === id))
  const project = useStudio((s) => s.project)
  const pxPerBeat = useLayout((s) => s.rollZoom)
  const pxPerTick = pxPerBeat / PPQ
  // Bars that overlap the clip, for the ruler and the grid lines.
  const bars = timeMap(project)
    .barsUntil(clip.start + clip.length)
    .filter((bar) => bar.start + bar.length > clip.start)
  const scroller = useRef<HTMLDivElement>(null)
  const playhead = useRef<HTMLDivElement>(null)
  /** New notes take the length of the last note drawn or resized. */
  const lastLength = useRef(snap)
  const [menu, openMenu] = useMenu()
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const width = clip.length * pxPerTick
  const drums = track.instrument === 'drums'
  const grow = useLayout((s) => s.patternGrow)
  // The key may change along the clip, so it is asked for by position: `key` is the one the clip starts in, which the
  // keyboard at the left is labelled by, and each note is judged by the key where it falls.
  const segments = drums ? [] : keySegments(project)
  const keyAtTick = (tick: number): Key | null => segmentAt(segments, tick)?.key ?? null
  const keyOf = (note: { start: number }): Key | null => keyAtTick(clip.start + note.start)
  const key = keyAtTick(clip.start)
  const inClip = segments.filter((segment) => segment.tick < clip.start + clip.length && segment.end > clip.start)
  /** More than one key in the clip: the rows are then lit stretch by stretch, not along their whole length. */
  const keyed = inClip.length > 1
  const lock = useLayout((s) => s.scaleLock) && !!key
  const fold = useLayout((s) => s.scaleFold) && !!key
  const nameOf = (pitch: number): string => (drums ? DRUM_NAMES[pitch % 12] : key ? noteName(pitch, key) : pitchName(pitch))

  // The rows, top to bottom. Folded, only the key's notes have one, and any other note the clip uses, so that nothing in it is out of sight.
  const used = new Set(clip.notes.map((n) => n.pitch))
  const rows = fold && key ? PITCHES.filter((pitch) => inClip.some((segment) => inKey(segment.key, pitch)) || used.has(pitch)) : PITCHES
  const rowIndex = new Map(rows.map((pitch, i) => [pitch, i]))
  const rowOf = (pitch: number): number => rowIndex.get(pitch) ?? Math.max(0, rows.findIndex((each) => each <= pitch))
  const pitchAtRow = (row: number): number => rows[clamp(row, 0, rows.length - 1)]
  /** Where a pitch that has been dragged or drawn ends up: on the notes of the key in force at `start` (in the clip) when locked or folded, leaning the way it was going. */
  const settle = (pitch: number, lean: number, start: number): number => {
    const here = lock || fold ? keyOf({ start }) : null
    return here ? nearestInKey(here, pitch, lean) : pitch
  }

  // Bring the clip's notes into view when a different clip is opened.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const pitches = clip.notes.map((n) => n.pitch)
    const centre = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60
    el.scrollTop = rowOf(Math.round(centre)) * ROW_HEIGHT - el.clientHeight / 2
    el.scrollLeft = 0
    useStudio.setState({ selectedNoteIds: [] })
    // Only when the clip changes, not as its notes are edited.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id])

  useFrame(() => {
    const el = playhead.current
    if (!el) return
    const x = (engine.getPosition() - clip.start) * pxPerTick
    el.style.display = x >= 0 && x <= width ? 'block' : 'none'
    el.style.transform = `translateX(${x}px)`
  })

  const zoom = (factor: number): void => setLayout({ rollZoom: clamp(pxPerBeat * factor, ROLL_ZOOM.min, ROLL_ZOOM.max) })

  /** With Shift or Cmd/Ctrl held, dragging over the grid draws a box and selects the notes it touches. Shift adds to the selection. */
  const beginMarquee = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const x0 = e.clientX - rect.left
    const y0 = e.clientY - rect.top
    const base = e.shiftKey ? selected : []
    useStudio.setState({ selectedNoteIds: base })
    startDrag(
      e,
      (dx, dy) => {
        // Measured afresh: the grid may have scrolled under the pointer since the drag began.
        const now = el.getBoundingClientRect()
        const x1 = e.clientX + dx - now.left
        const y1 = e.clientY + dy - now.top
        const left = Math.max(0, Math.min(x0, x1))
        const top = Math.max(0, Math.min(y0, y1))
        const right = Math.max(x0, x1)
        const bottom = Math.max(y0, y1)
        setMarquee({ left, top, width: right - left, height: bottom - top })
        const highest = pitchAtRow(Math.floor(top / ROW_HEIGHT))
        const lowest = pitchAtRow(Math.floor(bottom / ROW_HEIGHT))
        const hit = clip.notes
          .filter((n) => n.pitch <= highest && n.pitch >= lowest && n.start * pxPerTick < right && (n.start + n.length) * pxPerTick > left)
          .map((n) => n.id)
        useStudio.setState({ selectedNoteIds: [...new Set([...base, ...hit])] })
      },
      () => setMarquee(null)
    )
  }

  const drawNote = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || e.target !== e.currentTarget) return
    if (e.shiftKey || e.metaKey || e.ctrlKey) return beginMarquee(e)
    const rect = e.currentTarget.getBoundingClientRect()
    const start = snapTo((e.clientX - rect.left) / pxPerTick, snap, 'floor')
    const pitch = clamp(settle(pitchAtRow(Math.floor((e.clientY - rect.top) / ROW_HEIGHT)), -1, start), LOW, HIGH)
    if (start < 0 || start >= clip.length) return
    const room = clip.length - start
    const note: Note = { id: newId(), pitch, start, length: Math.min(lastLength.current, room), velocity: 0.8 }
    const gesture = `draw-${note.id}`
    addNote(clip.id, note, gesture)
    useStudio.setState({ selectedNoteIds: [note.id] })
    engine.noteOn(track.id, pitch, note.velocity)
    startDrag(
      e,
      (dx) => {
        const length = clamp(snapTo(note.length + dx / pxPerTick, snap), snap, room)
        lastLength.current = length
        updateNote(clip.id, note.id, { length }, gesture)
      },
      () => engine.noteOff(track.id, pitch)
    )
  }

  const dragNote = (e: React.PointerEvent, note: Note, mode: 'move' | 'resize'): void => {
    e.stopPropagation()
    if (e.button !== 0) return
    // Shift-click adds to or removes from the selection; a plain click on an unselected note selects just it.
    if (e.shiftKey) {
      useStudio.setState({ selectedNoteIds: selected.includes(note.id) ? selected.filter((id) => id !== note.id) : [...selected, note.id] })
      return
    }
    const group = selected.includes(note.id) ? selected : [note.id]
    if (group !== selected) useStudio.setState({ selectedNoteIds: group })
    const originals = new Map(clip.notes.filter((n) => group.includes(n.id)).map((n) => [n.id, n]))
    const earliest = Math.min(...[...originals.values()].map((n) => n.start))

    const gesture = `${mode}-${note.id}`
    let pitch = note.pitch
    engine.noteOn(track.id, pitch, note.velocity)
    startDrag(
      e,
      (dx, dy) => {
        if (mode === 'resize') {
          const length = clamp(snapTo(note.length + dx / pxPerTick, snap), snap, clip.length - note.start)
          lastLength.current = length
          const change = length - note.length
          updateNotes(clip.id, group, (n) => ({ ...n, length: Math.max(snap, originals.get(n.id)!.length + change) }), gesture)
          return
        }
        // The whole selection moves by the same amount as the note being dragged.
        const start = clamp(snapTo(note.start + dx / pxPerTick, snap), 0, clip.length - snap)
        const shift = Math.max(-earliest, start - note.start)
        // By rows, not semitones: folded, a row down is the next note of the key.
        const next = clamp(settle(pitchAtRow(rowOf(note.pitch) + Math.round(dy / ROW_HEIGHT)), -dy, note.start + shift), LOW, HIGH)
        if (next !== pitch) {
          engine.noteOff(track.id, pitch)
          pitch = next
          engine.noteOn(track.id, pitch, note.velocity)
        }
        updateNotes(
          clip.id,
          group,
          (n) => {
            const original = originals.get(n.id)!
            // The rest of the selection moves by as many semitones, each then settling on the key in its own right.
            return { ...n, start: original.start + shift, pitch: clamp(n.id === note.id ? next : settle(original.pitch + next - note.pitch, next - note.pitch, original.start + shift), 0, 127) }
          },
          gesture
        )
      },
      () => engine.noteOff(track.id, pitch)
    )
  }

  /** Dragging in the velocity lane sets the velocity of whichever notes the pointer passes over. */
  const paintVelocity = (e: React.PointerEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    const startX = e.clientX
    const startY = e.clientY
    const paint = (x: number, y: number): void => {
      const rect = el.getBoundingClientRect()
      const tick = (x - rect.left) / pxPerTick
      const velocity = clamp(1 - (y - rect.top) / VELOCITY_HEIGHT, 0.02, 1)
      const under = clip.notes
        .filter((n) => tick >= n.start - 30 && tick < n.start + Math.max(n.length, 120))
        .filter((n) => !selected.length || selected.includes(n.id))
        .map((n) => n.id)
      if (under.length) updateNotes(clip.id, under, (n) => ({ ...n, velocity }), 'velocity')
    }
    paint(startX, startY)
    startDrag(e, (dx, dy) => paint(startX + dx, startY + dy))
  }

  const audition = (e: React.PointerEvent, pitch: number): void => {
    engine.noteOn(track.id, pitch, 0.8)
    startDrag(e, () => {}, () => engine.noteOff(track.id, pitch))
  }

  const seek = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const startX = e.clientX
    const at = (x: number): number => clip.start + clamp(snapTo((x - el.getBoundingClientRect().left) / pxPerTick, snap), 0, clip.length)
    engine.seek(at(startX))
    startDrag(e, (dx) => engine.seek(at(startX + dx)))
  }

  // The chord of each bar: the clip's own, or under a melody or a bass line the one the other tracks are playing.
  const chords = drums ? [] : barChords(project, track, clip, bars, keyAtTick)
  // The palette's chords are those of the key where the next chord would go: after what the clip already holds.
  const paletteKey = keyOf({ start: clip.notes.reduce((end, note) => Math.max(end, note.start + note.length), 0) }) ?? key
  const lastOwn = [...chords].reverse().find((chord) => chord && !chord.borrowed)
  const barTicks = bars[0]?.length ?? PPQ * 4

  /** Whether a note is outside the key where it falls. */
  const outsideKey = (note: Note): boolean => {
    const here = keyOf(note)
    return !!here && !inKey(here, note.pitch)
  }

  /** One step up or down: a semitone, or with Lock on a step of the key. */
  const nudge = (by: number): void => (lock && key ? stepNotesInKey(clip.id, selected, by, keyOf) : transposeNotes(clip.id, selected, by))
  // The notes outside the key, among those the tools act on: the selection, or every note when none is selected.
  const strays = clip.notes.filter((n) => (!selected.length || selected.includes(n.id)) && outsideKey(n)).map((n) => n.id)

  const selectAll = (): void => useStudio.setState({ selectedNoteIds: clip.notes.map((n) => n.id) })

  /**
   * Starts the clip from a part (a bass line, chords, a figure for a synth),
   * in the key and over the chords and the drums that are there now. A short clip is made eight bars long first, if
   * that is wanted, so the part can run its course. One undo step.
   */
  const startFrom = (line: Part): void => {
    const now = useStudio.getState().project
    const length = grow ? roomFor(now, track, clip) : clip.length
    const notes = partNotes(line, now, track, clip, length)
    replaceClip({ ...clip, length, notes })
    useStudio.setState({ selectedNoteIds: [] })
    // A bass line sits low and a lead high: bring what was written into view.
    const el = scroller.current
    const pitches = notes.map((n) => n.pitch)
    if (el && pitches.length) el.scrollTop = rowOf(Math.round((Math.min(...pitches) + Math.max(...pitches)) / 2)) * ROW_HEIGHT - el.clientHeight / 2
  }
  const grid = SNAP_OPTIONS.find(([, ticks]) => ticks === snap)?.[0] ?? ''

  /** What a right-click offers for a set of notes; the heading says which. */
  const noteItems = (ids: string[], heading: string): Parameters<typeof openMenu>[1] => [
    { heading },
    { label: `Quantise to ${grid}`, disabled: !clip.notes.length, onSelect: () => quantiseNotes(clip.id, ids, snap) },
    { label: 'Up an Octave', disabled: !clip.notes.length, onSelect: () => transposeNotes(clip.id, ids, 12) },
    { label: 'Down an Octave', disabled: !clip.notes.length, onSelect: () => transposeNotes(clip.id, ids, -12) },
    { separator: true },
    { label: 'Select All', disabled: !clip.notes.length, onSelect: selectAll }
  ]

  return (
    <div className="pr">
      <div className="pr-bar">
        <TextField className="pr-name" label="Clip name" value={clip.name} onCommit={(name) => name.trim() && updateClip(clip.id, { name: name.trim() })} />
        <span className="pr-track">
          <span className="pr-dot" style={{ background: track.color }} />
          {track.name}
        </span>
        {viewSwitch}
        {!isDrumTrack(track) && (
          <div className="pr-picker">
            <Picker
              label="Start from a part…"
              title="Replace the clip's notes with a bass line, chords or a synth figure, in the song's key and following its chords"
              placeholder="Search bass lines, chords, melodies"
              sections
              groups={[...new Set(PARTS.map((each) => each.style))].sort().map((style) => ({
                label: style,
                options: PARTS.filter((each) => each.style === style)
                  .sort(partOrder)
                  .map((each) => ({ value: each, label: each.name, detail: each.follow ? 'follows the kick' : each.bpm === 'any' ? '' : `${each.bpm} bpm`, sub: headingOf(each) }))
              }))}
              onPick={startFrom}
              actions={[{ label: `${grow ? '✓ ' : ''}Make the clip eight bars long`, onSelect: () => setLayout({ patternGrow: !grow }) }]}
            />
          </div>
        )}
        <span className="pr-sep" />
        <span className="pr-label">Grid</span>
        <Segmented label="Grid" value={String(snap)} options={GRIDS} onChange={(value) => useStudio.setState({ snap: Number(value) })} />
        <Button title="Move note starts onto the grid" disabled={!clip.notes.length} onClick={() => quantiseNotes(clip.id, selected, snap)}>
          Quantise
        </Button>
        <span className="pr-sep" />
        <span className="pr-label">Transpose</span>
        <div className="pr-group">
          <Button title="Down an octave" disabled={!clip.notes.length} onClick={() => transposeNotes(clip.id, selected, -12)}>
            −12
          </Button>
          <Button title={lock ? 'Down a step of the key (↓)' : 'Down a semitone (↓)'} disabled={!clip.notes.length} onClick={() => nudge(-1)}>
            −1
          </Button>
          <Button title={lock ? 'Up a step of the key (↑)' : 'Up a semitone (↑)'} disabled={!clip.notes.length} onClick={() => nudge(1)}>
            +1
          </Button>
          <Button title="Up an octave" disabled={!clip.notes.length} onClick={() => transposeNotes(clip.id, selected, 12)}>
            +12
          </Button>
        </div>
        <span className="pr-scope" title="What Quantise and Transpose act on">
          {selected.length ? `${selected.length} selected` : 'All notes'}
        </span>
        {!drums && (
          <>
            <span className="pr-sep" />
            <KeyPicker at={clip.start} look="compact" />
            {key && (
              <>
                <Toggle label="Lock: notes drawn or moved go only to notes of the key" size="sm" pressed={lock} onChange={(on) => setLayout({ scaleLock: on })}>
                  Lock
                </Toggle>
                <Toggle label="Fold: show rows for the key's notes only" size="sm" pressed={fold} onChange={(on) => setLayout({ scaleFold: on })}>
                  Fold
                </Toggle>
                {strays.length > 0 && (
                  <Button title={`Move ${strays.length === 1 ? 'the note that is' : `the ${strays.length} notes that are`} outside the key to the nearest note in it`} onClick={() => fixNotesToKey(clip.id, strays, keyOf)}>
                    Fix {strays.length}
                  </Button>
                )}
              </>
            )}
          </>
        )}
        <span className="pr-space" />
        <div className="pr-group" title="Zoom the piano roll">
          <IconButton label="Zoom out" size="sm" onClick={() => zoom(1 / 1.25)}>
            <ZoomIcon d="M4 8h8" />
          </IconButton>
          <IconButton label="Zoom in" size="sm" onClick={() => zoom(1.25)}>
            <ZoomIcon d="M4 8h8M8 4v8" />
          </IconButton>
        </div>
      </div>

      {paletteKey && <ChordBar track={track} clip={clip} songKey={paletteKey} barTicks={barTicks} lastDegree={lastOwn?.degree ?? null} />}

      <div className="pr-scroll" ref={scroller}>
        <div className="pr-ruler-row">
          <div className="pr-corner" />
          <div className="pr-ruler" style={{ width }} onPointerDown={seek} title="Click to move the playhead">
            {bars.map((bar) => (
              <div
                key={bar.index}
                className="pr-ruler-bar"
                style={{ left: (bar.start - clip.start) * pxPerTick, width: bar.length * pxPerTick, backgroundSize: `${bar.beatTicks * pxPerTick}px 100%` }}
              >
                {bar.index + 1}
              </div>
            ))}
          </div>
        </div>

        {!drums && (
          <div className="pr-chord-row">
            <div className="pr-corner">Chord</div>
            <div className="pr-chord-lane" style={{ width }}>
              {bars.map((bar, i) => {
                const chord = chords[i]
                return (
                  chord && (
                    <div
                      key={bar.index}
                      className={`pr-chord ${chord.borrowed ? 'borrowed' : ''} ${key && !chord.numeral ? 'foreign' : ''}`}
                      style={{ left: Math.max(0, (bar.start - clip.start) * pxPerTick), width: bar.length * pxPerTick }}
                      title={
                        (chord.borrowed ? `The other tracks play ${chord.name} in this bar` : `This bar is ${chord.name}`) +
                        (chord.numeral ? `, the ${chord.numeral} chord of the key` : key ? ', which is not one of the key\u2019s chords' : '')
                      }
                    >
                      <strong>{chord.name}</strong>
                      {chord.numeral && <span>{chord.numeral}</span>}
                    </div>
                  )
                )
              })}
            </div>
          </div>
        )}

        <div className="pr-inner" style={{ height: rows.length * ROW_HEIGHT }}>
          <div className="pr-keys">
            {rows.map((pitch) => (
              <div
                key={pitch}
                className={`pr-key ${isBlackKey(pitch) ? 'black' : ''} ${drums ? 'drum' : ''} ${key ? `named ${inKey(key, pitch) ? '' : 'out'} ${isRoot(key, pitch) ? 'root' : ''}` : ''}`}
                style={{ height: ROW_HEIGHT }}
                title={key ? `${nameOf(pitch)}${isRoot(key, pitch) ? ', the root of the key' : inKey(key, pitch) ? ', in the key' : ', not in the key'}` : nameOf(pitch)}
                onPointerDown={(e) => audition(e, pitch)}
              >
                {/* With a key, every one of its notes is named: the keyboard is then a chart of the scale. */}
                {drums ? DRUM_NAMES[pitch % 12] : key ? (inKey(key, pitch) ? noteName(pitch, key) : '') : pitch % 12 === 0 ? pitchName(pitch) : ''}
              </div>
            ))}
          </div>
          <div
            className="pr-grid"
            style={{ width }}
            title="Click to draw a note. Shift- or Cmd-drag to select several. Right-click for more."
            onPointerDown={drawNote}
            onContextMenu={(e) => e.target === e.currentTarget && openMenu(e, noteItems(selected, selected.length ? `${selected.length} selected` : 'All notes'))}
          >
            {rows.map((pitch) => (
              <div
                key={pitch}
                className={`pr-row ${key && !keyed ? (isRoot(key, pitch) ? 'root' : inKey(key, pitch) ? 'in' : 'out') : isBlackKey(pitch) ? 'black' : ''} ${pitch % 12 === 0 ? 'octave' : ''}`}
                style={{ height: ROW_HEIGHT }}
              />
            ))}
            {/* With a change of key in the clip, each stretch lights its own key's rows. */}
            {keyed &&
              inClip.map((segment) => {
                const left = Math.max(0, (segment.tick - clip.start) * pxPerTick)
                const right = Math.min(width, (segment.end - clip.start) * pxPerTick)
                return (
                  <div key={segment.id ?? 'start'} className={`pr-key-seg ${segment.tick > clip.start ? 'change' : ''}`} style={{ left, width: right - left }}>
                    {rows.map((pitch) => (
                      <div key={pitch} className={`pr-row ${isRoot(segment.key, pitch) ? 'root' : inKey(segment.key, pitch) ? 'in' : 'out'}`} style={{ height: ROW_HEIGHT }} />
                    ))}
                  </div>
                )
              })}
            {bars.map((bar) => (
              <div
                key={bar.index}
                className="pr-lines"
                style={{
                  left: (bar.start - clip.start) * pxPerTick,
                  width: bar.length * pxPerTick,
                  backgroundSize: `${bar.length * pxPerTick}px 100%, ${bar.beatTicks * pxPerTick}px 100%, ${snap * pxPerTick}px 100%`,
                  // Zoomed far out, the finest lines would merge into a wash.
                  backgroundImage: snap * pxPerTick < 5 ? 'linear-gradient(to right, var(--border-strong) 1px, transparent 1px), linear-gradient(to right, var(--border) 1px, transparent 1px)' : undefined
                }}
              />
            ))}
            {/* The root of each bar's chord, in every octave: where a bass note or a melody's resting note sits best. */}
            {bars.map((bar, i) => {
              const chord = chords[i]
              if (!chord) return null
              const left = Math.max(0, (bar.start - clip.start) * pxPerTick)
              const right = Math.min(width, (bar.start + bar.length - clip.start) * pxPerTick)
              return rows.map((pitch, row) =>
                pitch % 12 === chord.root ? <div key={`${bar.index}:${pitch}`} className="pr-chord-root" style={{ left, width: right - left, top: row * ROW_HEIGHT, height: ROW_HEIGHT }} /> : null
              )
            })}
            {clip.notes.map((note) => {
              if (note.start < 0 || note.start >= clip.length) return null
              const noteWidth = Math.max(4, Math.min(note.length, clip.length - note.start) * pxPerTick - 1)
              const isSelected = selected.includes(note.id)
              const outside = outsideKey(note)
              return (
                <div
                  key={note.id}
                  className={`pr-note ${isSelected ? 'selected' : ''} ${outside ? 'outside' : ''}`}
                  title={`${nameOf(note.pitch)}${outside ? ' · not in the key' : ''} · velocity ${Math.round(note.velocity * 127)}`}
                  style={{
                    left: note.start * pxPerTick,
                    top: rowOf(note.pitch) * ROW_HEIGHT,
                    width: noteWidth,
                    height: ROW_HEIGHT - 1,
                    background: track.color,
                    opacity: 0.55 + note.velocity * 0.45
                  }}
                  onPointerDown={(e) => dragNote(e, note, 'move')}
                  onContextMenu={(e) => {
                    // A right-click on a note outside the selection is about that note alone.
                    const ids = isSelected ? selected : [note.id]
                    if (!isSelected) useStudio.setState({ selectedNoteIds: ids })
                    openMenu(e, [
                      ...noteItems(ids, ids.length > 1 ? `${ids.length} notes` : nameOf(note.pitch)),
                      { separator: true },
                      { label: ids.length > 1 ? 'Delete Notes' : 'Delete Note', shortcut: '⌫', danger: true, onSelect: () => removeNotes(clip.id, ids) }
                    ])
                  }}
                >
                  {!drums && noteWidth >= 30 && <span className="pr-note-name">{nameOf(note.pitch)}</span>}
                  <div className="pr-note-resize" onPointerDown={(e) => dragNote(e, note, 'resize')} />
                </div>
              )
            })}
            {marquee && <div className="pr-marquee" style={marquee} />}
            <div className="pr-playhead" ref={playhead} />
          </div>
        </div>

        {/* Velocity lane: one stem per note, pinned to the bottom of the editor. */}
        <div className="pr-velocity">
          <div className="pr-velocity-label">Velocity</div>
          <div className="pr-velocity-lane" style={{ width, height: VELOCITY_HEIGHT }} onPointerDown={paintVelocity} title="Drag across to set velocities">
            {clip.notes.map((note) =>
              note.start < 0 || note.start >= clip.length ? null : (
                <div
                  key={note.id}
                  className={`pr-stem ${selected.includes(note.id) ? 'selected' : ''}`}
                  style={{ left: note.start * pxPerTick, height: note.velocity * (VELOCITY_HEIGHT - 6), '--stem': track.color } as React.CSSProperties}
                />
              )
            )}
          </div>
        </div>
      </div>
      {menu}
    </div>
  )
}

function ZoomIcon({ d }: { d: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}
