import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  AUTOMATION_RANGE,
  clipStretch,
  newId,
  PPQ,
  projectEnd,
  type AutomationPoint,
  type AutomationTarget,
  type Clip,
  type Project,
  type Track
} from '@shared/model'
import { engine } from '../engine'
import { importAudioFiles, runCommand } from '../platform'
import { timeMap, type Bar, type TimeMap } from '@shared/timemap'
import {
  addMarker,
  addMeterChange,
  addMidiClip,
  duplicateClips,
  addTempoChange,
  findClip,
  placeClips,
  removeClips,
  removeMarker,
  removeMeterChange,
  removeTempoChange,
  replaceClip,
  selectClip,
  setAutomation,
  setLoop,
  setMeter,
  setTempo,
  splitClips,
  trimmedStart,
  updateClip,
  updateMarker
} from '../state/actions'
import { assetInfo, MAX_ZOOM, MIN_ZOOM, useStudio } from '../state/store'
import { snapTo, startDrag, useFrame } from '../util'
import { NumberField, TextField } from '../components/controls'
import { IconButton } from './controls/buttons'
import { Caret, useMenu, type MenuItem } from './controls/Popover'
import { HEADER_WIDTH, SNAP_BAR, SNAP_OFF, SNAP_OPTIONS, setLayout, useLayout } from './layout'
import { TrackHeader } from './TrackHeader'

/** Opens a menu at the pointer. Handed down to everything in the timeline that has one. */
type OpenMenu = (event: React.MouseEvent, items: MenuItem[]) => void

/**
 * Rounds a position to the timeline's snap setting: a division of the beat,
 * the nearest bar line, or (snap off) the nearest tick.
 */
function snapper(snap: number, map: TimeMap): (tick: number) => number {
  if (snap === SNAP_OFF) return Math.round
  if (snap !== SNAP_BAR) return (tick) => snapTo(tick, snap)
  return (tick) => {
    const bar = map.barAt(Math.max(0, tick))
    return tick - bar.start < bar.length / 2 ? bar.start : bar.start + bar.length
  }
}

/** The shortest a clip can be made by dragging its edge. */
const minLength = (snap: number): number => (snap > 0 ? Math.min(snap, PPQ) : PPQ / 4)

/** Must match --track-height in styles.css. */
const TRACK_HEIGHT = 72
/** Must match --ruler-height and --global-row-height in styles.css. */
const RULER_HEIGHT = 26
const GLOBAL_ROW_HEIGHT = 22
const CLIP_BODY_HEIGHT = 46
const GLOBAL_ROWS = 3
/** Must match the loop band's height in next.css. */
const LOOP_BAND = 9
/**
 * Only what is near the visible part of the timeline is rendered. The
 * rendered window extends this far past each edge and moves in steps, so
 * scrolling a little does not re-render anything.
 */
const VIEW_MARGIN = 600
const VIEW_STEP = 512

/** The rendered window, in pixels from the start of the timeline. */
interface View {
  from: number
  to: number
}

/**
 * The arrangement. Beyond the current one it has: a snap setting (in the
 * corner) that every drag obeys; the tempo, signature and marker rows fold
 * away; drag across empty lanes to select clips; a loop region that can be
 * dragged and resized; and a menu on right-click for clips, lanes, the
 * ruler and markers, so nothing is reachable only by a gesture you have to
 * know about.
 */
export function Timeline(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const snap = useLayout((s) => s.snap)
  const globals = useLayout((s) => s.globals)
  const globalRows = globals ? GLOBAL_ROWS : 0
  const [menu, openMenu] = useMenu()
  const inner = useRef<HTMLDivElement>(null)
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const pxPerBeat = useStudio((s) => s.pxPerBeat)
  const pxPerTick = pxPerBeat / PPQ
  const map = timeMap(project)
  // Room for 64 bars, or a good stretch past the last clip.
  const bars = map.barsUntil(Math.max(map.barStart(64), projectEnd(project) + PPQ * 64))
  const last = bars[bars.length - 1]
  const width = (last.start + last.length) * pxPerTick

  const arrange = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<View>({ from: 0, to: 4096 })
  const measure = useCallback(() => {
    const el = arrange.current
    if (!el) return
    const from = Math.max(0, Math.floor((el.scrollLeft - VIEW_MARGIN) / VIEW_STEP) * VIEW_STEP)
    const to = from + el.clientWidth + VIEW_MARGIN * 2 + VIEW_STEP
    setView((v) => (v.from === from && v.to === to ? v : { from, to }))
  }, [])

  /** Set by a zoom gesture: the tick that should stay under the pointer once the new zoom is laid out. */
  const zoomAnchor = useRef<{ tick: number; x: number } | null>(null)

  useEffect(() => {
    const el = arrange.current
    if (!el) return
    // Pinch, or Cmd/Ctrl + scroll, zooms around the pointer.
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const current = useStudio.getState().pxPerBeat
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, current * Math.exp(-e.deltaY * 0.01)))
      const x = e.clientX - el.getBoundingClientRect().left - HEADER_WIDTH
      zoomAnchor.current = { tick: (el.scrollLeft + x) / (current / PPQ), x }
      useStudio.setState({ pxPerBeat: next })
    }
    const resize = new ResizeObserver(measure)
    resize.observe(el)
    el.addEventListener('scroll', measure, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      resize.disconnect()
      el.removeEventListener('scroll', measure)
      el.removeEventListener('wheel', onWheel)
    }
  }, [measure])

  useLayoutEffect(() => {
    const anchor = zoomAnchor.current
    if (anchor && arrange.current) arrange.current.scrollLeft = anchor.tick * pxPerTick - anchor.x
    zoomAnchor.current = null
    measure()
  }, [pxPerTick, measure])

  const playhead = useRef<HTMLDivElement>(null)
  useFrame(() => {
    const x = engine.getPosition() * pxPerTick
    if (playhead.current) playhead.current.style.transform = `translateX(${x}px)`
    // Follow: when the playhead leaves the visible stretch, page along to it.
    const el = arrange.current
    if (el && engine.isPlaying() && useStudio.getState().follow) {
      const visible = el.clientWidth - HEADER_WIDTH
      if (x < el.scrollLeft || x > el.scrollLeft + visible - 30) el.scrollLeft = Math.max(0, x - 60)
    }
  })

  const visibleBars = bars.filter((bar) => (bar.start + bar.length) * pxPerTick >= view.from && bar.start * pxPerTick <= view.to)

  /** Dragging across empty lanes draws a box and selects the clips it touches. With Shift or Cmd/Ctrl they are added to the selection. */
  const beginMarquee = (e: React.PointerEvent, track: Track): void => {
    if (e.button !== 0 || !inner.current) return
    const el = inner.current
    const origin = el.getBoundingClientRect()
    const x0 = e.clientX - origin.left
    const y0 = e.clientY - origin.top
    const base = e.shiftKey || e.metaKey || e.ctrlKey ? useStudio.getState().selectedClipIds : []
    useStudio.setState({ selectedTrackId: track.id, selectedClipIds: base })
    const lanesTop = RULER_HEIGHT + GLOBAL_ROW_HEIGHT * globalRows
    startDrag(
      e,
      (dx, dy) => {
        // Measured afresh: the timeline may have scrolled under the pointer since the drag began.
        const now = el.getBoundingClientRect()
        const x1 = e.clientX + dx - now.left
        const y1 = e.clientY + dy - now.top
        const left = Math.max(HEADER_WIDTH, Math.min(x0, x1))
        const top = Math.max(lanesTop, Math.min(y0, y1))
        const right = Math.max(x0, x1)
        const bottom = Math.max(y0, y1)
        setMarquee({ left, top, width: right - left, height: bottom - top })
        const from = (left - HEADER_WIDTH) / pxPerTick
        const to = (right - HEADER_WIDTH) / pxPerTick
        const firstRow = Math.floor((top - lanesTop) / TRACK_HEIGHT)
        const lastRow = Math.floor((bottom - lanesTop) / TRACK_HEIGHT)
        const hit = useStudio
          .getState()
          .project.tracks.slice(Math.max(0, firstRow), lastRow + 1)
          .flatMap((t) => t.clips.filter((c) => c.start < to && c.start + c.length > from).map((c) => c.id))
        useStudio.setState({ selectedClipIds: [...new Set([...base, ...hit])] })
      },
      () => setMarquee(null)
    )
  }

  const snapLabel = SNAP_OPTIONS.find(([value]) => value === snap)?.[1] ?? 'Off'

  return (
    <div className="arrange tl" ref={arrange}>
      <div className="arrange-inner" ref={inner} style={{ width: HEADER_WIDTH + width }}>
        {/* Bar and beat lines behind every lane. Bars differ in length when the time signature changes. */}
        <div className="grid" style={{ left: HEADER_WIDTH, top: RULER_HEIGHT + GLOBAL_ROW_HEIGHT * globalRows }}>
          {visibleBars.map((bar) => (
            <div
              className="grid-bar"
              key={bar.index}
              style={{
                left: bar.start * pxPerTick,
                width: bar.length * pxPerTick,
                backgroundSize: `${bar.beatTicks * pxPerTick}px 100%`,
                // Zoomed far out, beat lines would merge into a grey wash.
                backgroundImage: bar.beatTicks * pxPerTick < 5 ? 'none' : undefined
              }}
            />
          ))}
        </div>
        <div className="ruler-row">
          <div className="corner tl-corner" style={{ width: HEADER_WIDTH }}>
            <IconButton label={globals ? 'Hide the tempo, signature and marker rows' : 'Show the tempo, signature and marker rows'} size="sm" onClick={() => setLayout({ globals: !globals })}>
              <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden style={{ transform: globals ? undefined : 'rotate(-90deg)' }}>
                <path d="M2 4.25 6 8l4-3.75" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </IconButton>
            <span className="tl-count">
              {project.tracks.length} {project.tracks.length === 1 ? 'track' : 'tracks'}
            </span>
            <button
              type="button"
              className={`tl-snap ${snap === SNAP_OFF ? '' : 'on'}`}
              title="Snap: what clips, the playhead and the loop line up with when dragged"
              aria-haspopup="menu"
              onClick={(event) =>
                openMenu(event, [{ heading: 'Snap to' }, ...SNAP_OPTIONS.map(([value, label]) => ({ label, checked: snap === value, onSelect: () => setLayout({ snap: value }) }))])
              }
            >
              Snap <strong>{snapLabel}</strong>
              <Caret />
            </button>
          </div>
          <Ruler project={project} map={map} pxPerTick={pxPerTick} bars={visibleBars} snap={snap} openMenu={openMenu} />
        </div>
        {globals && (
          <>
            <TempoRow map={map} pxPerTick={pxPerTick} snap={snap} openMenu={openMenu} />
            <MeterRow map={map} pxPerTick={pxPerTick} openMenu={openMenu} />
            <MarkerRow project={project} map={map} pxPerTick={pxPerTick} snap={snap} openMenu={openMenu} />
          </>
        )}
        {project.tracks.map((track) => (
          <div className="track-row" key={track.id}>
            <TrackHeader track={track} />
            <Lane track={track} project={project} pxPerTick={pxPerTick} view={view} snap={snap} openMenu={openMenu} onMarquee={beginMarquee} />
          </div>
        ))}
        {project.tracks.length === 0 && <div className="empty">Add a track to get started.</div>}
        {marquee && <div className="tl-marquee" style={marquee} />}
        <div className="playhead" ref={playhead} style={{ left: HEADER_WIDTH }} />
      </div>
      {menu}
    </div>
  )
}

/** Named positions. Press M to drop one at the playhead. */
function MarkerRow({ project, map, pxPerTick, snap, openMenu }: { project: Project; map: TimeMap; pxPerTick: number; snap: number; openMenu: OpenMenu }): React.JSX.Element {
  const snapped = snapper(snap, map)
  return (
    <div className="global-row" style={{ top: RULER_HEIGHT + GLOBAL_ROW_HEIGHT * 2 }}>
      <div className="corner" style={{ width: HEADER_WIDTH }}>
        Markers
      </div>
      <div
        className="global-lane"
        title="Double-click to add a marker (or press M at the playhead). Right-click for more."
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget) return
          addMarker(snapped((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerTick))
        }}
        onContextMenu={(e) => {
          const tick = snapped((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerTick)
          openMenu(e, [{ label: 'Add Marker Here', onSelect: () => addMarker(tick) }])
        }}
      >
        {(project.markers ?? []).map((marker) => (
          <div
            className="marker flag"
            key={marker.id}
            style={{ left: marker.tick * pxPerTick }}
            onContextMenu={(e) =>
              openMenu(e, [
                { heading: marker.name },
                { label: 'Move Playhead Here', onSelect: () => engine.seek(marker.tick) },
                { separator: true },
                { label: 'Delete Marker', danger: true, onSelect: () => removeMarker(marker.id) }
              ])
            }
          >
            <button className="marker-go" title="Move the playhead here" onClick={() => engine.seek(marker.tick)}>
              ▸
            </button>
            <TextField className="marker-field marker-name" label="Marker name" value={marker.name} onCommit={(name) => updateMarker(marker.id, { name: name.trim() || marker.name })} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Tempo changes along the timeline. Each one holds until the next. */
function TempoRow({ map, pxPerTick, snap, openMenu }: { map: TimeMap; pxPerTick: number; snap: number; openMenu: OpenMenu }): React.JSX.Element {
  const snapped = snapper(snap, map)
  return (
    <div className="global-row" style={{ top: RULER_HEIGHT }}>
      <div className="corner" style={{ width: HEADER_WIDTH }}>
        Tempo
      </div>
      <div
        className="global-lane"
        title="Double-click to add a tempo change. Right-click for more."
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget) return
          addTempoChange(snapped((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerTick))
        }}
        onContextMenu={(e) => {
          const tick = snapped((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerTick)
          openMenu(e, [{ label: 'Add Tempo Change Here', disabled: tick <= 0, onSelect: () => addTempoChange(tick) }])
        }}
      >
        {map.tempos.map((tempo) => (
          <div
            className="marker"
            key={tempo.id ?? 'start'}
            style={{ left: tempo.tick * pxPerTick }}
            onContextMenu={(e) =>
              openMenu(e, [
                { heading: `${tempo.bpm} bpm` },
                { label: 'Move Playhead Here', onSelect: () => engine.seek(tempo.tick) },
                { separator: true },
                // The tempo the project starts at can be changed but not removed.
                { label: 'Delete Tempo Change', danger: true, disabled: !tempo.id, onSelect: () => tempo.id && removeTempoChange(tempo.id) }
              ])
            }
          >
            <NumberField className="marker-field" label="Tempo in beats per minute" value={tempo.bpm} onCommit={(bpm) => setTempo(tempo.id, bpm)} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Time-signature changes, which always fall on a bar line. */
function MeterRow({ map, pxPerTick, openMenu }: { map: TimeMap; pxPerTick: number; openMenu: OpenMenu }): React.JSX.Element {
  return (
    <div className="global-row" style={{ top: RULER_HEIGHT + GLOBAL_ROW_HEIGHT }}>
      <div className="corner" style={{ width: HEADER_WIDTH }}>
        Signature
      </div>
      <div
        className="global-lane"
        title="Double-click to add a time-signature change at that bar. Right-click for more."
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget) return
          addMeterChange(map.barAt((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerTick).index)
        }}
        onContextMenu={(e) => {
          const bar = map.barAt((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerTick).index
          openMenu(e, [{ label: `Add Signature Change at Bar ${bar + 1}`, disabled: bar <= 0, onSelect: () => addMeterChange(bar) }])
        }}
      >
        {map.meters.map((meter) => (
          <div
            className="marker"
            key={meter.id ?? 'start'}
            style={{ left: meter.tick * pxPerTick }}
            onContextMenu={(e) =>
              openMenu(e, [
                { heading: `${meter.numerator}/${meter.denominator}` },
                { label: 'Move Playhead Here', onSelect: () => engine.seek(meter.tick) },
                { separator: true },
                { label: 'Delete Signature Change', danger: true, disabled: !meter.id, onSelect: () => meter.id && removeMeterChange(meter.id) }
              ])
            }
          >
            <TextField
              className="marker-field"
              label="Time signature"
              value={`${meter.numerator}/${meter.denominator}`}
              onCommit={(text) => {
                const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(text)
                if (!match || !setMeter(meter.id, Number(match[1]), Number(match[2]))) {
                  window.alert('Enter a time signature like 3/4 or 6/8. The lower number can be 2, 4, 8 or 16.')
                }
              }}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function Ruler(props: { project: Project; map: TimeMap; pxPerTick: number; bars: Bar[]; snap: number; openMenu: OpenMenu }): React.JSX.Element {
  const { project, map, pxPerTick, bars, openMenu } = props
  const { loop } = project
  const snapped = snapper(props.snap, map)
  // When zoomed out, number only every second, fourth … bar so labels do not collide.
  const labelEvery = 2 ** Math.max(0, Math.ceil(Math.log2(30 / ((bars[0]?.length ?? PPQ * 4) * pxPerTick))))

  const head = useRef<HTMLDivElement>(null)
  useFrame(() => {
    if (head.current) head.current.style.transform = `translateX(${engine.getPosition() * pxPerTick}px)`
  })

  const tickAtX = (el: Element, x: number): number => Math.max(0, snapped((x - el.getBoundingClientRect().left) / pxPerTick))

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const startX = e.clientX
    // Dragging along the top band, or anywhere with Shift held, marks out the loop.
    if (e.shiftKey || e.clientY - el.getBoundingClientRect().top < LOOP_BAND) {
      const anchor = tickAtX(el, startX)
      startDrag(e, (dx) => {
        const other = tickAtX(el, startX + dx)
        if (other !== anchor) setLoop({ enabled: true, start: Math.min(anchor, other), end: Math.max(anchor, other) }, 'loop')
      })
    } else {
      engine.seek(tickAtX(el, startX))
      startDrag(e, (dx) => engine.seek(tickAtX(el, startX + dx)))
    }
  }

  /** Drags the loop region: its body moves it, an edge resizes it. */
  const dragLoop = (e: React.PointerEvent, edge: 'start' | 'end' | 'both'): void => {
    e.stopPropagation()
    const { start, end } = loop
    const least = minLength(props.snap)
    startDrag(e, (dx) => {
      const delta = dx / pxPerTick
      if (edge === 'both') {
        const moved = Math.max(0, snapped(start + delta))
        setLoop({ start: moved, end: moved + (end - start) }, 'loop')
      } else if (edge === 'start') setLoop({ start: Math.max(0, Math.min(end - least, snapped(start + delta))) }, 'loop')
      else setLoop({ end: Math.max(start + least, snapped(end + delta)) }, 'loop')
    })
  }

  const onContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const tick = tickAtX(e.currentTarget, e.clientX)
    const bar = map.barAt((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerTick)
    openMenu(e, [
      { label: 'Move Playhead Here', onSelect: () => engine.seek(tick) },
      { label: 'Add Marker Here', onSelect: () => addMarker(tick) },
      { label: 'Add Tempo Change Here', disabled: tick <= 0, onSelect: () => addTempoChange(tick) },
      { label: `Add Signature Change at Bar ${bar.index + 1}`, disabled: bar.index <= 0, onSelect: () => addMeterChange(bar.index) },
      { separator: true },
      { label: `Loop Bar ${bar.index + 1}`, onSelect: () => setLoop({ enabled: true, start: bar.start, end: bar.start + bar.length }) },
      { label: 'Loop', checked: loop.enabled, disabled: loop.end <= loop.start, onSelect: () => setLoop({ enabled: !loop.enabled }) },
      { label: 'Clear Loop', disabled: loop.end <= loop.start, onSelect: () => setLoop({ enabled: false, start: 0, end: 0 }) }
    ])
  }

  return (
    <div className="ruler" onPointerDown={onPointerDown} onContextMenu={onContextMenu} title="Click to move the playhead. Drag along the top edge (or Shift-drag) to mark a loop. Right-click for more.">
      <div className="tl-loop-band" />
      {bars.map((bar) => (
        <div
          className="tl-ruler-bar"
          key={bar.index}
          style={{
            left: bar.start * pxPerTick,
            width: bar.length * pxPerTick,
            backgroundSize: `${bar.beatTicks * pxPerTick}px 100%`,
            // Zoomed far out, beat ticks would merge into a solid line.
            backgroundImage: bar.beatTicks * pxPerTick < 5 ? 'none' : undefined
          }}
        >
          {bar.index % labelEvery === 0 ? bar.index + 1 : ''}
        </div>
      ))}
      {loop.end > loop.start && (
        <div
          className={`tl-loop ${loop.enabled ? 'on' : ''}`}
          style={{ left: loop.start * pxPerTick, width: (loop.end - loop.start) * pxPerTick }}
          title="The loop: drag to move it, drag an end to resize it"
          onPointerDown={(e) => dragLoop(e, 'both')}
        >
          <div className="tl-loop-edge start" onPointerDown={(e) => dragLoop(e, 'start')} />
          <div className="tl-loop-edge end" onPointerDown={(e) => dragLoop(e, 'end')} />
        </div>
      )}
      <div className="tl-ruler-head" ref={head} />
    </div>
  )
}

function Lane(props: {
  track: Track
  project: Project
  pxPerTick: number
  view: View
  snap: number
  openMenu: OpenMenu
  onMarquee: (event: React.PointerEvent, track: Track) => void
}): React.JSX.Element {
  const { track, project, pxPerTick, view, openMenu } = props
  const trackSelected = useStudio((s) => s.selectedTrackId === track.id)
  // Clips well outside the visible stretch are not rendered at all.
  const visibleClips = track.clips.filter((c) => (c.start + c.length) * pxPerTick >= view.from && c.start * pxPerTick <= view.to)
  const selectedClipIds = useStudio((s) => s.selectedClipIds)
  const automation = useStudio((s) => s.automationLanes[track.id])
  const recordingHere = useStudio((s) => s.recordingFrom !== null && s.armedTrackId === track.id)
  const map = timeMap(project)

  const tickAt = (e: React.MouseEvent<HTMLDivElement>): number =>
    (e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerTick

  return (
    <div
      className={`lane ${trackSelected ? 'selected' : ''}`}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) props.onMarquee(e, track)
      }}
      onContextMenu={(e) => {
        if (e.target !== e.currentTarget) return
        const at = tickAt(e)
        const bar = map.barAt(at)
        const tick = Math.max(0, snapper(props.snap, map)(at))
        openMenu(e, [
          ...(track.kind === 'midi' ? [{ label: `New Clip at Bar ${bar.index + 1}`, onSelect: () => addMidiClip(track.id, bar.start, bar.length) }] : []),
          ...(track.kind === 'audio' ? [{ label: 'Import Audio…', onSelect: () => runCommand('importAudio') }] : []),
          { label: 'Move Playhead Here', onSelect: () => engine.seek(tick) },
          { label: 'Add Marker Here', onSelect: () => addMarker(tick) }
        ])
      }}
      onDoubleClick={(e) => {
        if (e.target !== e.currentTarget || track.kind !== 'midi') return
        // A new clip fills the bar that was double-clicked.
        const bar = map.barAt(tickAt(e))
        addMidiClip(track.id, bar.start, bar.length)
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault()
      }}
      onDrop={(e) => {
        e.preventDefault()
        const files = Array.from(e.dataTransfer.files)
        if (files.length) void importAudioFiles(files, track.id, Math.max(0, snapper(props.snap, map)(tickAt(e))))
      }}
    >
      {track.clips.length === 0 && (
        <span className="lane-hint">
          {track.kind === 'midi' ? 'Double-click to create a clip' : track.kind === 'bus' ? 'Bus: other tracks send audio here' : 'Drop audio files here'}
        </span>
      )}
      {visibleClips.map((clip) => (
        <ClipView key={clip.id} clip={clip} track={track} project={project} pxPerTick={pxPerTick} view={view} selected={selectedClipIds.includes(clip.id)} snap={props.snap} openMenu={openMenu} />
      ))}
      {recordingHere && <RecordingRegion pxPerTick={pxPerTick} />}
      {automation && <AutomationLane track={track} target={automation} pxPerTick={pxPerTick} />}
    </div>
  )
}

function ClipView(props: {
  clip: Clip
  track: Track
  project: Project
  pxPerTick: number
  view: View
  selected: boolean
  snap: number
  openMenu: OpenMenu
}): React.JSX.Element {
  const { clip, track, project, pxPerTick, view, selected, openMenu } = props
  const snapped = snapper(props.snap, timeMap(project))
  const select = (): void => {
    if (!useStudio.getState().selectedClipIds.includes(clip.id)) selectClip(clip.id, track.id)
  }

  const move = (e: React.PointerEvent): void => {
    e.stopPropagation()
    // Shift or Cmd/Ctrl-click adds to or removes from the selection.
    if (e.shiftKey || e.metaKey || e.ctrlKey) return selectClip(clip.id, track.id, true)
    select()
    const { project: before, selectedClipIds } = useStudio.getState()
    const origins = new Map<string, number>()
    for (const id of selectedClipIds) {
      const found = findClip(before, id)
      if (found) origins.set(id, found.clip.start)
    }
    const earliest = Math.min(...origins.values())
    const row = before.tracks.findIndex((t) => t.id === track.id)
    startDrag(
      e,
      (dx, dy) => {
        const delta = Math.max(-earliest, snapped(clip.start + dx / pxPerTick) - clip.start)
        const starts = new Map([...origins].map(([id, start]) => [id, start + delta]))
        // A single clip can also be dragged to another track of the same kind.
        const target = origins.size === 1 ? before.tracks[row + Math.round(dy / TRACK_HEIGHT)] : undefined
        placeClips(starts, target ? { clipId: clip.id, trackId: target.id } : null, `move-${clip.id}`)
      },
      // A plain click on one of several selected clips narrows the selection to it.
      (moved) => !moved && selectClip(clip.id, track.id)
    )
  }

  const trim = (e: React.PointerEvent): void => {
    e.stopPropagation()
    select()
    startDrag(e, (dx) => {
      const next = trimmedStart(clip, snapped(clip.start + dx / pxPerTick), timeMap(project))
      const current = findClip(useStudio.getState().project, clip.id)?.clip
      if (next && current && next.start !== current.start) replaceClip(next, `trim-${clip.id}`)
    })
  }

  const resize = (e: React.PointerEvent): void => {
    e.stopPropagation()
    select()
    // An audio clip cannot extend past the end of its file.
    let max = Infinity
    if (clip.kind === 'audio') {
      const asset = project.assets[clip.assetId]
      if (asset) max = Math.round(timeMap(project).ticksAfter(clip.start, (asset.duration - clip.offset) * clipStretch(clip).stretch))
    }
    startDrag(e, (dx) => {
      // The end of the clip is what snaps, not its length.
      const length = Math.min(max, Math.max(minLength(props.snap), snapped(clip.start + clip.length + dx / pxPerTick) - clip.start))
      updateClip(clip.id, { length }, `resize-${clip.id}`)
    })
  }

  const width = Math.max(4, clip.length * pxPerTick)
  return (
    <div
      className={`clip ${selected ? 'selected' : ''}`}
      style={{ left: clip.start * pxPerTick, width, '--clip-color': track.color } as React.CSSProperties}
      onPointerDown={(e) => (e.button === 0 ? move(e) : e.stopPropagation())}
      onDoubleClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        // A right-click on a clip outside the selection is about that clip alone.
        select()
        const ids = useStudio.getState().selectedClipIds
        openMenu(e, [
          { heading: ids.length > 1 ? `${ids.length} clips` : clip.name },
          { label: 'Split at Playhead', shortcut: '⌘E', onSelect: () => splitClips(ids, engine.getPosition()) },
          { label: 'Duplicate', shortcut: '⌘D', onSelect: () => duplicateClips(ids) },
          { separator: true },
          { label: ids.length > 1 ? 'Delete Clips' : 'Delete Clip', shortcut: '⌫', danger: true, onSelect: () => removeClips(ids) }
        ])
      }}
    >
      <div className="clip-title">{clip.name}</div>
      <ClipCanvas
        clip={clip}
        project={project}
        pxPerTick={pxPerTick}
        color={track.color}
        width={width}
        // The part of the clip inside the rendered window, in pixels from the clip's left edge.
        from={Math.min(width, Math.max(0, view.from - clip.start * pxPerTick))}
        to={Math.min(width, Math.max(0, view.to - clip.start * pxPerTick))}
      />
      <div className="clip-trim" onPointerDown={trim} />
      <div className="clip-resize" onPointerDown={resize} />
    </div>
  )
}

/** Draws a clip's notes or waveform. */
function ClipCanvas(props: {
  clip: Clip
  project: Project
  pxPerTick: number
  color: string
  /** Width of the whole clip. */
  width: number
  /** The stretch of the clip to draw; a long clip is never drawn whole. */
  from: number
  to: number
}): React.JSX.Element {
  const { clip, project, pxPerTick, color } = props
  const from = Math.floor(props.from)
  const assetsVersion = useStudio((s) => s.assetsVersion)
  const ref = useRef<HTMLCanvasElement>(null)
  const width = Math.max(1, Math.ceil(props.to) - from)
  const height = CLIP_BODY_HEIGHT

  useEffect(() => {
    const canvas = ref.current
    const g = canvas?.getContext('2d')
    if (!canvas || !g) return
    const scale = window.devicePixelRatio || 1
    canvas.width = width * scale
    canvas.height = height * scale
    g.scale(scale, scale)
    g.clearRect(0, 0, width, height)
    // From here on, x is measured from the clip's left edge.
    g.translate(-from, 0)
    g.fillStyle = color

    if (clip.kind === 'midi') {
      if (!clip.notes.length) return
      let low = Infinity
      let high = -Infinity
      for (const note of clip.notes) {
        low = Math.min(low, note.pitch)
        high = Math.max(high, note.pitch)
      }
      const span = Math.max(12, high - low + 1)
      const row = (height - 6) / span
      for (const note of clip.notes) {
        if (note.start < 0 || note.start >= clip.length) continue
        const y = 3 + (high - note.pitch) * row + (span - (high - low + 1)) * row * 0.5
        g.fillRect(note.start * pxPerTick, y, Math.max(2, note.length * pxPerTick - 1), Math.max(2, row - 1))
      }
      return
    }

    const info = assetInfo.get(clip.assetId)
    if (!info) {
      g.globalAlpha = 0.6
      g.font = '11px system-ui'
      g.fillText('Audio file offline', from + 6, height / 2 + 4)
      return
    }
    // The tempo may change under the clip, so each pixel column is mapped to file time separately.
    const map = timeMap(project)
    const clipSeconds = map.tickToSeconds(clip.start)
    const { stretch } = clipStretch(clip)
    const fileTime = (x: number): number => clip.offset + (map.tickToSeconds(clip.start + x / pxPerTick) - clipSeconds) / stretch
    const mid = height / 2
    const count = info.peaks.length / 2
    for (let x = from; x < from + width; x++) {
      const first = Math.floor(fileTime(x) / info.secondsPerPeak)
      const to = Math.max(first + 1, Math.floor(fileTime(x + 1) / info.secondsPerPeak))
      if (first >= count) break
      let min = 0
      let max = 0
      for (let i = Math.max(0, first); i < to && i < count; i++) {
        min = Math.min(min, info.peaks[i * 2])
        max = Math.max(max, info.peaks[i * 2 + 1])
      }
      const top = mid - max * (mid - 2)
      g.fillRect(x, top, 1, Math.max(1, mid - min * (mid - 2) - top))
    }

    // Shade the fades.
    const end = clip.start + clip.length
    const fadeIn = map.ticksAfter(clip.start, clip.fadeIn ?? 0) * pxPerTick
    const fadeOut = (end - map.secondsToTick(map.tickToSeconds(end) - (clip.fadeOut ?? 0))) * pxPerTick
    g.fillStyle = 'rgb(0 0 0 / 45%)'
    if (fadeIn > 0) {
      g.beginPath()
      g.moveTo(0, 0)
      g.lineTo(fadeIn, 0)
      g.lineTo(0, height)
      g.fill()
    }
    if (fadeOut > 0) {
      g.beginPath()
      g.moveTo(props.width, 0)
      g.lineTo(props.width - fadeOut, 0)
      g.lineTo(props.width, height)
      g.fill()
    }
  }, [clip, project.bpm, project.tempoChanges, pxPerTick, color, from, width, height, assetsVersion, props.width])

  return <canvas ref={ref} className="clip-canvas" style={{ width, height, marginLeft: from }} />
}

/** The growing red block shown on the armed track while a take is being recorded. */
function RecordingRegion({ pxPerTick }: { pxPerTick: number }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useFrame(() => {
    const from = useStudio.getState().recordingFrom
    if (!ref.current || from === null) return
    ref.current.style.left = `${from * pxPerTick}px`
    ref.current.style.width = `${Math.max(2, (engine.getPosition() - from) * pxPerTick)}px`
  })
  return <div className="recording-region" ref={ref} />
}

const AUTOMATION_PAD = 6

/**
 * An automation curve drawn over a track's lane. Click to add a point, drag
 * points to move them, right-click a point to delete it.
 */
function AutomationLane(props: { track: Track; target: AutomationTarget; pxPerTick: number }): React.JSX.Element {
  const { track, target, pxPerTick } = props
  const points = track.automation?.[target] ?? []
  const { min, max, label } = AUTOMATION_RANGE[target]
  const span = TRACK_HEIGHT - 1 - AUTOMATION_PAD * 2
  const yOf = (value: number): number => AUTOMATION_PAD + (1 - (value - min) / (max - min)) * span
  const valueOf = (y: number): number => Math.min(max, Math.max(min, max - ((y - AUTOMATION_PAD) / span) * (max - min)))

  /** Drags a point (which may have just been created) around the lane. */
  const drag = (e: React.PointerEvent, point: AutomationPoint, others: AutomationPoint[]): void => {
    e.stopPropagation()
    const gesture = `automation-${point.id}`
    startDrag(e, (dx, dy) => {
      const tick = Math.max(0, snapTo(point.tick + dx / pxPerTick, PPQ / 4))
      setAutomation(track.id, target, [...others, { ...point, tick, value: valueOf(yOf(point.value) + dy) }], gesture)
    })
  }

  const add = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (e.button !== 0) return
    const rect = e.currentTarget.getBoundingClientRect()
    const point: AutomationPoint = {
      id: newId(),
      tick: Math.max(0, snapTo((e.clientX - rect.left) / pxPerTick, PPQ / 4)),
      value: valueOf(e.clientY - rect.top)
    }
    setAutomation(track.id, target, [...points, point], `automation-${point.id}`)
    drag(e, point, points)
  }

  // With no points the parameter sits at the track's fixed value.
  const line = points.length
    ? `M0,${yOf(points[0].value)} ${points.map((p) => `L${p.tick * pxPerTick},${yOf(p.value)}`).join(' ')} L1000000,${yOf(points[points.length - 1].value)}`
    : `M0,${yOf(track[target])} L1000000,${yOf(track[target])}`

  return (
    <svg className="automation" onPointerDown={add} onDoubleClick={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
      <title>{`${label} automation: click to add a point, drag to move, right-click to delete`}</title>
      <path d={line} className={points.length ? '' : 'idle'} style={{ stroke: track.color }} />
      {points.map((point) => (
        <circle
          key={point.id}
          cx={point.tick * pxPerTick}
          cy={yOf(point.value)}
          r={4.5}
          style={{ fill: track.color }}
          onPointerDown={(e) => e.button === 0 && drag(e, point, points.filter((p) => p.id !== point.id))}
          onContextMenu={(e) => {
            e.preventDefault()
            setAutomation(track.id, target, points.filter((p) => p.id !== point.id))
          }}
        />
      ))}
    </svg>
  )
}
