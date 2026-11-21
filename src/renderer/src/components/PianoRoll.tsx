import { useEffect, useRef } from 'react'
import { DRUM_NAMES, newId, PPQ, type MidiClip, type Note, type Track } from '@shared/model'
import { timeMap } from '@shared/timemap'
import { engine } from '../engine'
import { addNote, quantiseNotes, removeNote, transposeNotes, updateNote, updateNotes } from '../state/actions'
import { useStudio } from '../state/store'
import { isBlackKey, pitchName, snapTo, startDrag, useFrame } from '../util'
import { SNAP_OPTIONS } from './Transport'

const ROW_HEIGHT = 14
const LOW = 24 // C1
const HIGH = 107 // B7
const VELOCITY_HEIGHT = 56
const PX_PER_BEAT = 96
const PX_PER_TICK = PX_PER_BEAT / PPQ
const PITCHES = Array.from({ length: HIGH - LOW + 1 }, (_, i) => HIGH - i)

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export function PianoRoll({ track, clip }: { track: Track; clip: MidiClip }): React.JSX.Element {
  const snap = useStudio((s) => s.snap)
  const selectedNoteIds = useStudio((s) => s.selectedNoteIds)
  // The tools act on the selected notes, or on every note when none is selected.
  const selected = selectedNoteIds.filter((id) => clip.notes.some((n) => n.id === id))
  const project = useStudio((s) => s.project)
  // Bars that overlap the clip, for the grid lines.
  const bars = timeMap(project)
    .barsUntil(clip.start + clip.length)
    .filter((bar) => bar.start + bar.length > clip.start)
  const scroller = useRef<HTMLDivElement>(null)
  const playhead = useRef<HTMLDivElement>(null)
  /** New notes take the length of the last note drawn or resized. */
  const lastLength = useRef(snap)
  const width = clip.length * PX_PER_TICK
  const drums = track.instrument === 'drums'

  // Bring the clip's notes into view when a different clip is opened.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const pitches = clip.notes.map((n) => n.pitch)
    const centre = pitches.length ? (Math.min(...pitches) + Math.max(...pitches)) / 2 : 60
    el.scrollTop = (HIGH - centre) * ROW_HEIGHT - el.clientHeight / 2
    el.scrollLeft = 0
    useStudio.setState({ selectedNoteIds: [] })
  }, [clip.id])

  useFrame(() => {
    const el = playhead.current
    if (!el) return
    const x = (engine.getPosition() - clip.start) * PX_PER_TICK
    el.style.display = x >= 0 && x <= width ? 'block' : 'none'
    el.style.transform = `translateX(${x}px)`
  })

  const drawNote = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || e.target !== e.currentTarget) return
    const rect = e.currentTarget.getBoundingClientRect()
    const start = snapTo((e.clientX - rect.left) / PX_PER_TICK, snap, 'floor')
    const pitch = clamp(HIGH - Math.floor((e.clientY - rect.top) / ROW_HEIGHT), LOW, HIGH)
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
        const length = clamp(snapTo(note.length + dx / PX_PER_TICK, snap), snap, room)
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
          const length = clamp(snapTo(note.length + dx / PX_PER_TICK, snap), snap, clip.length - note.start)
          lastLength.current = length
          const change = length - note.length
          updateNotes(clip.id, group, (n) => ({ ...n, length: Math.max(snap, originals.get(n.id)!.length + change) }), gesture)
          return
        }
        // The whole selection moves by the same amount as the note being dragged.
        const start = clamp(snapTo(note.start + dx / PX_PER_TICK, snap), 0, clip.length - snap)
        const shift = Math.max(-earliest, start - note.start)
        const next = clamp(note.pitch - Math.round(dy / ROW_HEIGHT), LOW, HIGH)
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
            return { ...n, start: original.start + shift, pitch: clamp(original.pitch + next - note.pitch, 0, 127) }
          },
          gesture
        )
      },
      () => engine.noteOff(track.id, pitch)
    )
  }

  /** Dragging in the velocity lane sets the velocity of whichever notes the pointer passes over. */
  const paintVelocity = (e: React.PointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    const paint = (x: number, y: number): void => {
      const tick = (x - rect.left) / PX_PER_TICK
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

  return (
    <div className="roll">
      <div className="roll-bar">
        <strong>{clip.name}</strong>
        <span className="muted">{track.name}</span>
        <label className="field">
          <span>Grid</span>
          <select aria-label="Grid" value={snap} onChange={(e) => useStudio.setState({ snap: Number(e.target.value) })}>
            {SNAP_OPTIONS.map(([label, ticks]) => (
              <option key={ticks} value={ticks}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <div className="group">
          <button title="Move note starts onto the grid" onClick={() => quantiseNotes(clip.id, selected, snap)}>
            Quantise
          </button>
          <button title="Down an octave" onClick={() => transposeNotes(clip.id, selected, -12)}>−12</button>
          <button title="Down a semitone (↓)" onClick={() => transposeNotes(clip.id, selected, -1)}>−1</button>
          <button title="Up a semitone (↑)" onClick={() => transposeNotes(clip.id, selected, 1)}>+1</button>
          <button title="Up an octave" onClick={() => transposeNotes(clip.id, selected, 12)}>+12</button>
        </div>
        <span className="muted">{selected.length ? `${selected.length} selected` : 'all notes'}</span>
        <span className="muted hint">Click to draw · drag to move · shift-click to select more · right-click to delete</span>
      </div>
      <div className="roll-scroll" ref={scroller}>
        <div className="roll-inner" style={{ height: PITCHES.length * ROW_HEIGHT }}>
          <div className="keys">
            {PITCHES.map((pitch) => (
              <div
                key={pitch}
                className={`key ${isBlackKey(pitch) ? 'black' : ''} ${drums ? 'drum' : ''}`}
                style={{ height: ROW_HEIGHT }}
                onPointerDown={(e) => audition(e, pitch)}
              >
                {drums ? DRUM_NAMES[pitch % 12] : pitch % 12 === 0 ? pitchName(pitch) : ''}
              </div>
            ))}
          </div>
          <div className="roll-grid" style={{ width }} onPointerDown={drawNote} onContextMenu={(e) => e.preventDefault()}>
            {PITCHES.map((pitch) => (
              <div
                key={pitch}
                className={`roll-row ${isBlackKey(pitch) ? 'black' : ''} ${pitch % 12 === 0 ? 'octave' : ''}`}
                style={{ height: ROW_HEIGHT }}
              />
            ))}
            {bars.map((bar) => (
              <div
                key={bar.index}
                className="roll-lines"
                style={{
                  left: (bar.start - clip.start) * PX_PER_TICK,
                  width: bar.length * PX_PER_TICK,
                  backgroundSize: `${bar.length * PX_PER_TICK}px 100%, ${bar.beatTicks * PX_PER_TICK}px 100%, ${snap * PX_PER_TICK}px 100%`
                }}
              />
            ))}
            {clip.notes.map((note) =>
              note.start < 0 || note.start >= clip.length ? null : (
                <div
                  key={note.id}
                  className={`note ${selected.includes(note.id) ? 'selected' : ''}`}
                  title={drums ? DRUM_NAMES[note.pitch % 12] : pitchName(note.pitch)}
                  style={{
                    left: note.start * PX_PER_TICK,
                    top: (HIGH - note.pitch) * ROW_HEIGHT,
                    width: Math.max(4, Math.min(note.length, clip.length - note.start) * PX_PER_TICK - 1),
                    height: ROW_HEIGHT - 1,
                    background: track.color,
                    opacity: 0.55 + note.velocity * 0.45
                  }}
                  onPointerDown={(e) => dragNote(e, note, 'move')}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    removeNote(clip.id, note.id)
                  }}
                >
                  <div className="note-resize" onPointerDown={(e) => dragNote(e, note, 'resize')} />
                </div>
              )
            )}
            <div className="roll-playhead" ref={playhead} />
          </div>
        </div>
        {/* Velocity lane: one stem per note, pinned to the bottom of the editor. */}
        <div className="velocity">
          <div className="velocity-label">Velocity</div>
          <div className="velocity-lane" style={{ width, height: VELOCITY_HEIGHT }} onPointerDown={paintVelocity}>
            {clip.notes.map((note) =>
              note.start < 0 || note.start >= clip.length ? null : (
                <div
                  key={note.id}
                  className={`stem ${selected.includes(note.id) ? 'selected' : ''}`}
                  style={{ left: note.start * PX_PER_TICK, height: note.velocity * VELOCITY_HEIGHT, background: track.color }}
                />
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
