import { useRef, useState } from 'react'
import { PPQ, type MidiClip, type Note, type Track } from '@shared/model'
import { timeMap } from '@shared/timemap'
import { ACCENT, DIVISIONS, GHOST, NORMAL, PATTERNS, fill, hits, humanise, kitFor, patternNotes, vary } from '../drums'
import { engine } from '../engine'
import { togglePlay } from '../recording'
import { findClip, replaceClip, setLoop, updateClip } from '../state/actions'
import { useStudio } from '../state/store'
import { startDrag, useFrame } from '../util'
import { Button, Segmented, Toggle } from './controls/buttons'
import { Dial } from './controls/Dial'
import { Picker } from './controls/Picker'
import { MenuButton, useMenu, type MenuItem } from './controls/Popover'
import { TextField } from './controls/fields'
import { setLayout, useDrumRows, useLayout } from './layout'

const CELL = 26
const LABEL = 104
/** How far a swung step can be pushed back: half a step, which at sixteenths is a hard shuffle. */
const SWING_REACH = 0.5
/** How close to where swing puts it a note must be to count as on the grid, in ticks. */
const NEAR = 8

const endGesture = (): void => useStudio.getState().endGesture()

/**
 * The step sequencer: a MIDI clip seen as a grid, a row to a drum and a
 * column to a step, for building a beat by switching hits on and off. It
 * reads and writes the clip's notes and nothing else, so what is made here
 * is an ordinary clip, playable on any kit and editable in the piano roll.
 *
 * Click a step to put a hit on it, or drag along a row to fill it. Shift
 * makes an accent and Alt a ghost note; a right-click offers those and
 * rolls. From the keyboard the arrows move, Enter switches a hit on or off,
 * and 2, 3 and 4 make a roll. A rhythm can be started from a pattern, then
 * varied, given a fill, swung and made less even.
 */
export function StepSequencer({ track, clip, viewSwitch }: { track: Track; clip: MidiClip; /** The switch between this and the piano roll, which the clip editor supplies. */ viewSwitch?: React.ReactNode }): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const playing = useStudio((s) => s.playing)
  const division = useLayout((s) => s.stepDivision)
  const kit = kitFor(track)
  const chosenRows = useDrumRows((s) => s[track.id])
  const [menu, openMenu] = useMenu()
  const [cursor, setCursor] = useState<{ row: number; step: number } | null>(null)
  const grid = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLDivElement>(null)
  /** While the pointer is dragged along the grid: whether it is putting hits in or taking them out, and how loud. */
  const paint = useRef<{ on: boolean; velocity: number } | null>(null)

  const stepTicks = PPQ / division
  const steps = Math.max(1, Math.ceil(clip.length / stepTicks))
  // The kit's usual rows, or the user's, and a row for any note the clip has that neither covers: nothing in the clip is out of sight.
  const base = chosenRows ?? kit.rows
  const strays = [...new Set(clip.notes.map((n) => n.pitch))].filter((pitch) => !base.includes(pitch)).sort((a, b) => b - a)
  const rows = [...strays, ...base]
  const nameOf = (pitch: number): string => kit.names[pitch] ?? `Note ${pitch}`

  const cells = new Map<string, Note[]>()
  for (const note of clip.notes) {
    if (note.start < 0 || note.start >= clip.length) continue
    const key = `${note.pitch}:${Math.floor(note.start / stepTicks)}`
    cells.set(key, [...(cells.get(key) ?? []), note])
  }
  const cellAt = (pitch: number, step: number): Note[] => cells.get(`${pitch}:${step}`) ?? []

  // Where the beats and bars fall, for the shading. The clip need not start on a bar line.
  const map = timeMap(project)
  const marks = Array.from({ length: steps }, (_, step) => {
    const tick = clip.start + step * stepTicks
    const bar = map.barAt(tick)
    return bar.start === tick ? 'bar' : (tick - bar.start) % bar.beatTicks === 0 ? 'beat' : ''
  })

  useFrame(() => {
    const el = head.current
    if (!el) return
    const step = Math.floor((engine.getPosition() - clip.start) / stepTicks)
    const inside = engine.isPlaying() && step >= 0 && step < steps
    el.style.display = inside ? 'block' : 'none'
    if (inside) el.style.transform = `translateX(${LABEL + step * CELL}px)`
  })

  /** The clip as it is now: a drag makes many changes between renders, each of which must build on the last. */
  const latest = (): MidiClip => {
    const found = findClip(useStudio.getState().project, clip.id)?.clip
    return found?.kind === 'midi' ? found : clip
  }
  const write = (notes: Note[], gesture?: string): void => replaceClip({ ...latest(), notes }, gesture)

  const audition = (pitch: number, velocity: number): void => {
    // While the beat is playing the change is heard in it; a second sound on top only muddies it.
    if (engine.isPlaying()) return
    engine.noteOn(track.id, pitch, velocity)
    window.setTimeout(() => engine.noteOff(track.id, pitch), 140)
  }

  /** Puts `count` hits on a step (none, to clear it), in place of what was there. */
  const setCell = (pitch: number, step: number, count: number, velocity: number, gesture?: string): void => {
    const now = latest()
    const start = step * stepTicks
    const others = now.notes.filter((n) => !(n.pitch === pitch && n.start >= start && n.start < start + stepTicks))
    // A swung step keeps its swing.
    const placed = count ? hits(pitch, start + (count === 1 ? swingOffset(step) : 0), stepTicks, velocity, count) : []
    replaceClip({ ...now, notes: [...others, ...placed] }, gesture)
    if (count) audition(pitch, velocity)
  }

  const velocityFor = (event: { shiftKey: boolean; altKey: boolean }): number => (event.shiftKey ? ACCENT : event.altKey ? GHOST : NORMAL)

  const onCellDown = (event: React.PointerEvent, pitch: number, step: number): void => {
    if (event.button !== 0) return
    setCursor({ row: rows.indexOf(pitch), step })
    const on = cellAt(pitch, step).length === 0
    paint.current = { on, velocity: velocityFor(event) }
    setCell(pitch, step, on ? 1 : 0, paint.current.velocity, 'steps-paint')
    // One undo step for the whole stroke; `startDrag` ends it when the button comes up.
    startDrag(event, () => {}, () => (paint.current = null))
  }
  const onCellEnter = (event: React.PointerEvent, pitch: number, step: number): void => {
    const stroke = paint.current
    if (!stroke || event.buttons !== 1) return
    const has = latest().notes.some((n) => n.pitch === pitch && Math.floor(n.start / stepTicks) === step)
    if (has !== stroke.on) setCell(pitch, step, stroke.on ? 1 : 0, stroke.velocity, 'steps-paint')
  }

  const cellMenu = (event: React.MouseEvent, pitch: number, step: number): void => {
    const there = cellAt(pitch, step)
    const loudness = there.length ? Math.max(...there.map((n) => n.velocity)) : NORMAL
    const level = (label: string, velocity: number): MenuItem => ({
      label,
      checked: there.length > 0 && Math.abs(loudness - velocity) < 0.05,
      onSelect: () => setCell(pitch, step, Math.max(1, there.length), velocity)
    })
    openMenu(event, [
      { heading: `${nameOf(pitch)} · step ${step + 1}` },
      level('Accent', ACCENT),
      level('Normal', NORMAL),
      level('Ghost note', GHOST),
      { separator: true },
      { label: 'Single hit', checked: there.length === 1, onSelect: () => setCell(pitch, step, 1, loudness) },
      ...[2, 3, 4].map((count): MenuItem => ({ label: `Roll of ${count}`, shortcut: String(count), checked: there.length === count, onSelect: () => setCell(pitch, step, count, loudness) })),
      { separator: true },
      { label: 'Clear', shortcut: '⌫', disabled: !there.length, onSelect: () => setCell(pitch, step, 0, 0) }
    ])
  }

  const focusCell = (row: number, step: number): void => {
    const to = { row: Math.min(rows.length - 1, Math.max(0, row)), step: Math.min(steps - 1, Math.max(0, step)) }
    setCursor(to)
    const el = grid.current?.querySelector<HTMLButtonElement>(`[data-cell="${to.row}:${to.step}"]`)
    el?.focus()
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }

  const onGridKey = (event: React.KeyboardEvent): void => {
    // Where the keyboard is, taken from the step that has the focus: surer than what was last noted down.
    const at = (event.target as HTMLElement).dataset?.cell?.split(':').map(Number)
    if (!at || at.length !== 2 || event.metaKey || event.ctrlKey) return
    const [row, step] = at
    const pitch = rows[row]
    const there = cellAt(pitch, step)
    const beat = division
    if (event.key === 'ArrowRight') focusCell(row, step + (event.shiftKey ? beat : 1))
    else if (event.key === 'ArrowLeft') focusCell(row, step - (event.shiftKey ? beat : 1))
    else if (event.key === 'ArrowDown') focusCell(row + 1, step)
    else if (event.key === 'ArrowUp') focusCell(row - 1, step)
    else if (event.key === 'Home') focusCell(row, 0)
    else if (event.key === 'End') focusCell(row, steps - 1)
    else if (event.key === 'Enter') setCell(pitch, step, there.length ? 0 : 1, velocityFor(event))
    else if (event.key === 'Backspace' || event.key === 'Delete') setCell(pitch, step, 0, 0)
    else if (event.key >= '1' && event.key <= '4') setCell(pitch, step, Number(event.key), there.length ? Math.max(...there.map((n) => n.velocity)) : NORMAL)
    else return
    event.preventDefault()
    // Arrows, Enter and Delete mean other things to the app outside the grid.
    event.stopPropagation()
  }

  // ── Swing: steps between the beats' halves played late. It is read from the notes and written to them; nothing else holds it.
  const swings = division === 4 || division === 8
  const single = clip.notes.filter((n) => Math.floor(n.start / stepTicks) % 2 === 1 && cellAt(n.pitch, Math.floor(n.start / stepTicks)).length === 1)
  const offsets = single.map((n) => n.start % stepTicks).sort((a, b) => a - b)
  const swungBy = offsets.length ? offsets[Math.floor(offsets.length / 2)] : 0
  const swing = swings ? Math.min(1, swungBy / (stepTicks * SWING_REACH)) : 0
  const swingOffset = (step: number): number => (swings && step % 2 === 1 ? swungBy : 0)
  const setSwing = (amount: number): void => {
    const to = Math.round(amount * stepTicks * SWING_REACH)
    write(
      latest().notes.map((n) => {
        const step = Math.floor(n.start / stepTicks)
        // Only hits that sit where swing put them move; a roll, or a note placed by hand off the grid, is left alone.
        if (step % 2 === 0 || Math.abs((n.start % stepTicks) - swungBy) > NEAR) return n
        return { ...n, start: step * stepTicks + to }
      }),
      `swing-${clip.id}`
    )
  }

  const looping = project.loop.enabled && project.loop.start === clip.start && project.loop.end === clip.start + clip.length
  const loopClip = (): void => {
    if (looping) return setLoop({ enabled: false })
    setLoop({ enabled: true, start: clip.start, end: clip.start + clip.length })
    if (!engine.isPlaying()) {
      engine.seek(clip.start)
      togglePlay()
    }
  }

  const setRows = (next: number[]): void => useDrumRows.setState({ [track.id]: next })
  const spare = Object.keys(kit.names)
    .map(Number)
    .filter((pitch) => !rows.includes(pitch))

  return (
    <div className="ss">
      <div className="pr-bar">
        <TextField className="pr-name" label="Clip name" value={clip.name} onCommit={(name) => name.trim() && updateClip(clip.id, { name: name.trim() })} />
        <span className="pr-track">
          <span className="pr-dot" style={{ background: track.color }} />
          {track.name}
        </span>
        {viewSwitch}
        <span className="pr-sep" />
        <div className="ss-picker">
          <Picker
            label="Start from a pattern…"
            title="Replace the clip's notes with a rhythm to work from"
            placeholder="Search patterns"
            groups={[...new Set(PATTERNS.map((each) => each.style))].map((style) => ({
              label: style,
              options: PATTERNS.filter((each) => each.style === style).map((each) => ({ value: each, label: each.name, detail: `${each.bpm} bpm` }))
            }))}
            onPick={(pattern) => write(patternNotes(pattern, kit, clip.length))}
          />
        </div>
        <div className="pr-group">
          <Button title="A relative of this rhythm: a couple of small changes" disabled={!clip.notes.length} onClick={() => write(vary(latest(), kit))}>
            Vary
          </Button>
          <Button title="Replace the last beat with a fill" disabled={clip.length < PPQ * 2} onClick={() => write(fill(latest(), kit))}>
            Fill
          </Button>
          <Button title="Make every hit a little louder or softer, at random" disabled={!clip.notes.length} onClick={() => write(humanise(latest().notes))}>
            Humanise
          </Button>
          <Button kind="danger" title="Remove every hit" disabled={!clip.notes.length} onClick={() => write([])}>
            Clear
          </Button>
        </div>
        <span className="pr-space" />
        <span className="pr-label">Grid</span>
        <Segmented label="Grid" value={String(division)} options={DIVISIONS.map(([count, label]) => [String(count), label] as const)} onChange={(value) => setLayout({ stepDivision: Number(value) })} />
        <div className="ss-swing" title={swings ? 'Swing: plays every second step late' : 'Swing applies to the 1/16 and 1/32 grids'}>
          <Dial label="Swing" size={22} min={0} max={1} snap={0.01} reset={0} disabled={!swings} value={swing} text={`${Math.round(swing * 100)}%`} onChange={setSwing} onEnd={endGesture} />
        </div>
        <Toggle label={looping ? 'Stop looping this clip' : 'Loop this clip and play it, to hear the beat while it is built'} pressed={looping && playing} onChange={loopClip}>
          Loop
        </Toggle>
      </div>

      <div className="ss-scroll">
        <div className="ss-grid" ref={grid} style={{ width: LABEL + steps * CELL }} onKeyDown={onGridKey} onContextMenu={(e) => e.preventDefault()}>
          <div className="ss-ruler">
            <div className="ss-label" />
            {marks.map((mark, step) => (
              <div key={step} className={`ss-tick ${mark}`}>
                {mark === 'bar' ? map.barAt(clip.start + step * stepTicks).index + 1 : mark === 'beat' ? '·' : ''}
              </div>
            ))}
          </div>
          {rows.map((pitch, row) => (
            <div className="ss-row" key={pitch}>
              <button
                type="button"
                className="ss-label"
                title={`${nameOf(pitch)}: click to hear it, right-click for more`}
                onPointerDown={() => audition(pitch, NORMAL)}
                onContextMenu={(event) =>
                  openMenu(event, [
                    { heading: nameOf(pitch) },
                    { label: 'Fill every step', onSelect: () => write([...latest().notes.filter((n) => n.pitch !== pitch), ...Array.from({ length: steps }, (_, step) => hits(pitch, step * stepTicks + swingOffset(step), stepTicks, NORMAL)).flat()]) },
                    { label: 'Clear this row', onSelect: () => write(latest().notes.filter((n) => n.pitch !== pitch)) },
                    { separator: true },
                    { label: 'Hide this row', disabled: clip.notes.some((n) => n.pitch === pitch), onSelect: () => setRows(rows.filter((each) => each !== pitch)) }
                  ])
                }
              >
                {nameOf(pitch)}
              </button>
              {marks.map((mark, step) => {
                const there = cellAt(pitch, step)
                const loudness = there.length ? Math.max(...there.map((n) => n.velocity)) : 0
                const active = cursor?.row === row && cursor.step === step
                return (
                  <button
                    key={step}
                    type="button"
                    data-cell={`${row}:${step}`}
                    // One stop for Tab; the arrow keys move within the grid.
                    tabIndex={active || (!cursor && row === 0 && step === 0) ? 0 : -1}
                    className={`ss-cell ${mark} ${there.length ? 'on' : ''}`}
                    aria-label={`${nameOf(pitch)}, step ${step + 1}${there.length ? (there.length > 1 ? `, roll of ${there.length}` : ', on') : ''}`}
                    aria-pressed={there.length > 0}
                    style={there.length ? ({ '--hit': track.color, '--level': 0.35 + loudness * 0.65 } as React.CSSProperties) : undefined}
                    onPointerDown={(event) => onCellDown(event, pitch, step)}
                    onPointerEnter={(event) => onCellEnter(event, pitch, step)}
                    onFocus={() => setCursor({ row, step })}
                    onContextMenu={(event) => cellMenu(event, pitch, step)}
                  >
                    {there.length > 1 ? there.length : ''}
                  </button>
                )
              })}
            </div>
          ))}
          <div className="ss-row ss-add">
            <div className="ss-label">
              <MenuButton label="Add a row" title="Show another of the kit's sounds" items={spare.map((pitch) => ({ label: kit.names[pitch], onSelect: () => setRows([pitch, ...rows]) }))} />
            </div>
          </div>
          <div className="ss-head" ref={head} style={{ width: CELL }} />
        </div>
      </div>
      <div className="ss-keys">
        <kbd>←</kbd>
        <kbd>→</kbd>
        <kbd>↑</kbd>
        <kbd>↓</kbd> move · <kbd>↵</kbd> hit on or off · <kbd>⇧↵</kbd> accent · <kbd>⌥↵</kbd> ghost · <kbd>2</kbd>
        <kbd>3</kbd>
        <kbd>4</kbd> roll · <kbd>⌫</kbd> clear · <kbd>space</kbd> play
      </div>
      {menu}
    </div>
  )
}
