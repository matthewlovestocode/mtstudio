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
import { importAudioFiles } from '../platform'
import { timeMap, type Bar, type TimeMap } from '@shared/timemap'
import { toggleArm } from '../recording'
import {
  addMarker,
  addMeterChange,
  addMidiClip,
  addTempoChange,
  findClip,
  placeClips,
  removeMarker,
  removeMeterChange,
  removeTempoChange,
  removeTrack,
  replaceClip,
  selectClip,
  setAutomation,
  setLoop,
  setMeter,
  setTempo,
  trimmedStart,
  updateClip,
  updateMarker,
  updateTrack
} from '../state/actions'
import { assetInfo, MAX_ZOOM, MIN_ZOOM, useStudio } from '../state/store'
import { snapTo, startDrag, useFrame } from '../util'
import { Meter, NumberField, Slider, TextField } from './controls'

const HEADER_WIDTH = 236
/** Must match --track-height in styles.css. */
const TRACK_HEIGHT = 72
/** Must match --ruler-height and --global-row-height in styles.css. */
const RULER_HEIGHT = 26
const GLOBAL_ROW_HEIGHT = 22
const CLIP_BODY_HEIGHT = 46
const GLOBAL_ROWS = 3
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

export function Timeline(): React.JSX.Element {
  const project = useStudio((s) => s.project)
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

  return (
    <div className="arrange" ref={arrange}>
      <div className="arrange-inner" style={{ width: HEADER_WIDTH + width }}>
        {/* Bar and beat lines behind every lane. Bars differ in length when the time signature changes. */}
        <div className="grid" style={{ left: HEADER_WIDTH, top: RULER_HEIGHT + GLOBAL_ROW_HEIGHT * GLOBAL_ROWS }}>
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
          <div className="corner" style={{ width: HEADER_WIDTH }}>
            {project.tracks.length} tracks
          </div>
          <Ruler project={project} pxPerTick={pxPerTick} bars={visibleBars} />
        </div>
        <TempoRow map={map} pxPerTick={pxPerTick} />
        <MeterRow map={map} pxPerTick={pxPerTick} />
        <MarkerRow project={project} pxPerTick={pxPerTick} />
        {project.tracks.map((track) => (
          <div className="track-row" key={track.id}>
            <TrackHeader track={track} />
            <Lane track={track} project={project} pxPerTick={pxPerTick} view={view} />
          </div>
        ))}
        {project.tracks.length === 0 && <div className="empty">Add a track to get started.</div>}
        <div className="playhead" ref={playhead} style={{ left: HEADER_WIDTH }} />
      </div>
    </div>
  )
}

/** Named positions. Press M to drop one at the playhead. */
function MarkerRow({ project, pxPerTick }: { project: Project; pxPerTick: number }): React.JSX.Element {
  return (
    <div className="global-row" style={{ top: RULER_HEIGHT + GLOBAL_ROW_HEIGHT * 2 }}>
      <div className="corner" style={{ width: HEADER_WIDTH }}>
        Markers
      </div>
      <div
        className="global-lane"
        title="Double-click to add a marker (or press M at the playhead). Right-click a marker to remove it."
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget) return
          addMarker(snapTo((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerTick, PPQ))
        }}
      >
        {(project.markers ?? []).map((marker) => (
          <div
            className="marker flag"
            key={marker.id}
            style={{ left: marker.tick * pxPerTick }}
            onContextMenu={(e) => {
              e.preventDefault()
              removeMarker(marker.id)
            }}
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
function TempoRow({ map, pxPerTick }: { map: TimeMap; pxPerTick: number }): React.JSX.Element {
  return (
    <div className="global-row" style={{ top: RULER_HEIGHT }}>
      <div className="corner" style={{ width: HEADER_WIDTH }}>
        Tempo
      </div>
      <div
        className="global-lane"
        title="Double-click to add a tempo change. Right-click a change to remove it."
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget) return
          addTempoChange(snapTo((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerTick, PPQ))
        }}
      >
        {map.tempos.map((tempo) => (
          <div
            className="marker"
            key={tempo.id ?? 'start'}
            style={{ left: tempo.tick * pxPerTick }}
            onContextMenu={(e) => {
              e.preventDefault()
              if (tempo.id) removeTempoChange(tempo.id)
            }}
          >
            <NumberField className="marker-field" label="Tempo in beats per minute" value={tempo.bpm} onCommit={(bpm) => setTempo(tempo.id, bpm)} />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Time-signature changes, which always fall on a bar line. */
function MeterRow({ map, pxPerTick }: { map: TimeMap; pxPerTick: number }): React.JSX.Element {
  return (
    <div className="global-row" style={{ top: RULER_HEIGHT + GLOBAL_ROW_HEIGHT }}>
      <div className="corner" style={{ width: HEADER_WIDTH }}>
        Signature
      </div>
      <div
        className="global-lane"
        title="Double-click to add a time-signature change at that bar. Right-click a change to remove it."
        onDoubleClick={(e) => {
          if (e.target !== e.currentTarget) return
          addMeterChange(map.barAt((e.clientX - e.currentTarget.getBoundingClientRect().left) / pxPerTick).index)
        }}
      >
        {map.meters.map((meter) => (
          <div
            className="marker"
            key={meter.id ?? 'start'}
            style={{ left: meter.tick * pxPerTick }}
            onContextMenu={(e) => {
              e.preventDefault()
              if (meter.id) removeMeterChange(meter.id)
            }}
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

function Ruler(props: { project: Project; pxPerTick: number; bars: Bar[] }): React.JSX.Element {
  const { project, pxPerTick, bars } = props
  const { loop } = project
  // When zoomed out, number only every second, fourth … bar so labels do not collide.
  const labelEvery = 2 ** Math.max(0, Math.ceil(Math.log2(30 / ((bars[0]?.length ?? PPQ * 4) * pxPerTick))))

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    const left = e.currentTarget.getBoundingClientRect().left
    const startX = e.clientX
    const tickAt = (x: number): number => Math.max(0, snapTo((x - left) / pxPerTick, PPQ))
    if (e.shiftKey) {
      const anchor = tickAt(startX)
      startDrag(e, (dx) => {
        const other = tickAt(startX + dx)
        if (other !== anchor) setLoop({ enabled: true, start: Math.min(anchor, other), end: Math.max(anchor, other) }, 'loop')
      })
    } else {
      engine.seek(tickAt(startX))
      startDrag(e, (dx) => engine.seek(tickAt(startX + dx)))
    }
  }

  return (
    <div className="ruler" onPointerDown={onPointerDown} title="Click to move the playhead. Shift-drag to set the loop.">
      {loop.end > loop.start && (
        <div
          className={`loop-region ${loop.enabled ? 'on' : ''}`}
          style={{ left: loop.start * pxPerTick, width: (loop.end - loop.start) * pxPerTick }}
        />
      )}
      {bars.map((bar) => (
        <span className="bar-label" key={bar.index} style={{ left: bar.start * pxPerTick }}>
          {bar.index % labelEvery === 0 ? bar.index + 1 : ''}
        </span>
      ))}
    </div>
  )
}

function TrackHeader({ track }: { track: Track }): React.JSX.Element {
  const selected = useStudio((s) => s.selectedTrackId === track.id)
  const armed = useStudio((s) => s.armedTrackId === track.id)
  const automation = useStudio((s) => s.automationLanes[track.id])
  // Off → volume → pan → off.
  const cycleAutomation = (): void => {
    const next: AutomationTarget | undefined = automation === undefined ? 'volume' : automation === 'volume' ? 'pan' : undefined
    useStudio.setState((s) => {
      const lanes = { ...s.automationLanes }
      if (next) lanes[track.id] = next
      else delete lanes[track.id]
      return { automationLanes: lanes }
    })
  }
  return (
    <div
      className={`track-header ${selected ? 'selected' : ''}`}
      style={{ width: HEADER_WIDTH }}
      onPointerDown={() =>
        // Picking a track also drops clips selected on other tracks, so the inspector shows this one.
        useStudio.setState((state) => ({
          selectedTrackId: track.id,
          selectedClipIds: state.selectedClipIds.filter((id) => track.clips.some((c) => c.id === id))
        }))
      }
    >
      <div className="track-color" style={{ background: track.color }} />
      <div className="track-main">
        <div className="track-line">
          <input
            className="track-name"
            aria-label="Track name"
            value={track.name}
            onChange={(e) => updateTrack(track.id, { name: e.target.value }, `name-${track.id}`)}
            onBlur={() => useStudio.getState().endGesture()}
          />
          <button
            className={`mini auto ${automation ? 'on' : ''}`}
            title={`Automation: ${automation ? AUTOMATION_RANGE[automation].label.toLowerCase() : 'off'} (click to change)`}
            onClick={cycleAutomation}
          >
            {automation === 'pan' ? 'Pa' : automation === 'volume' ? 'Vo' : 'A'}
          </button>
          {track.kind !== 'bus' && (
            <button className={`mini arm ${armed ? 'on' : ''}`} title="Arm for recording" onClick={() => void toggleArm(track.id)}>
              R
            </button>
          )}
          <button className={`mini mute ${track.mute ? 'on' : ''}`} title="Mute" onClick={() => updateTrack(track.id, { mute: !track.mute })}>
            M
          </button>
          <button className={`mini solo ${track.solo ? 'on' : ''}`} title="Solo" onClick={() => updateTrack(track.id, { solo: !track.solo })}>
            S
          </button>
          <button className="mini" title="Delete track" onClick={() => removeTrack(track.id)}>
            ×
          </button>
        </div>
        <div className="track-line">
          <Slider
            className="volume"
            label="Volume"
            min={0}
            max={1.5}
            step={0.01}
            reset={0.8}
            value={track.volume}
            onChange={(volume) => updateTrack(track.id, { volume }, `volume-${track.id}`)}
          />
          <Slider
            className="pan"
            label="Pan"
            min={-1}
            max={1}
            step={0.05}
            reset={0}
            value={track.pan}
            onChange={(pan) => updateTrack(track.id, { pan }, `pan-${track.id}`)}
          />
        </div>
        <Meter target={track.id} />
      </div>
    </div>
  )
}

function Lane(props: { track: Track; project: Project; pxPerTick: number; view: View }): React.JSX.Element {
  const { track, project, pxPerTick, view } = props
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
      className="lane"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) useStudio.setState({ selectedTrackId: track.id, selectedClipIds: [] })
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
        if (files.length) void importAudioFiles(files, track.id, Math.max(0, snapTo(tickAt(e), PPQ)))
      }}
    >
      {track.clips.length === 0 && (
        <span className="lane-hint">
          {track.kind === 'midi' ? 'Double-click to create a clip' : track.kind === 'bus' ? 'Bus: other tracks send audio here' : 'Drop audio files here'}
        </span>
      )}
      {visibleClips.map((clip) => (
        <ClipView key={clip.id} clip={clip} track={track} project={project} pxPerTick={pxPerTick} view={view} selected={selectedClipIds.includes(clip.id)} />
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
}): React.JSX.Element {
  const { clip, track, project, pxPerTick, view, selected } = props
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
        const delta = Math.max(-earliest, snapTo(clip.start + dx / pxPerTick, PPQ) - clip.start)
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
      const next = trimmedStart(clip, snapTo(clip.start + dx / pxPerTick, PPQ / 4), timeMap(project))
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
      const length = Math.min(max, Math.max(PPQ / 4, snapTo(clip.length + dx / pxPerTick, PPQ / 4)))
      updateClip(clip.id, { length }, `resize-${clip.id}`)
    })
  }

  const width = Math.max(4, clip.length * pxPerTick)
  return (
    <div
      className={`clip ${selected ? 'selected' : ''}`}
      style={{ left: clip.start * pxPerTick, width, '--clip-color': track.color } as React.CSSProperties}
      onPointerDown={move}
      onDoubleClick={(e) => e.stopPropagation()}
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
