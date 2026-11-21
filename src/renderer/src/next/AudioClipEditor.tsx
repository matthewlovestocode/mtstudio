import { useEffect, useRef, useState } from 'react'
import { clipStretch, type AudioClip, type Track } from '@shared/model'
import { timeMap } from '@shared/timemap'
import { TextField } from '../components/controls'
import { engine } from '../engine'
import { duplicateClips, removeClips, setClipStretch, splitClips, updateClip } from '../state/actions'
import { assetInfo, useStudio } from '../state/store'
import { startDrag, useFrame } from '../util'
import { Button } from './controls/buttons'
import { Dial } from './controls/Dial'
import { logCurve } from './controls/value'
import { decibels } from './mixing'

const STRETCH = logCurve(0.5, 2)
const endGesture = (): void => useStudio.getState().endGesture()

/**
 * The editor for an audio clip: its waveform across the width of the dock,
 * with the fades drawn on it and the playhead moving through it, and its
 * settings as knobs beside it. Click the waveform to move the playhead.
 */
export function AudioClipEditor({ track, clip }: { track: Track; clip: AudioClip }): React.JSX.Element {
  const asset = useStudio((s) => s.project.assets[clip.assetId])
  const project = useStudio((s) => s.project)
  const seconds = timeMap(project).duration(clip.start, clip.start + clip.length)
  const gain = clip.gain ?? 1
  const stretch = clip.stretch ?? 1
  const pitch = clip.pitch ?? 0
  const fadeIn = clip.fadeIn ?? 0
  const fadeOut = clip.fadeOut ?? 0
  const set = (patch: Partial<AudioClip>, key: string): void => updateClip(clip.id, patch, `clip-${key}-${clip.id}`)
  return (
    <div className="ace">
      <div className="pr-bar">
        <TextField className="pr-name" label="Clip name" value={clip.name} onCommit={(name) => name.trim() && updateClip(clip.id, { name: name.trim() })} />
        <span className="pr-track">
          <span className="pr-dot" style={{ background: track.color }} />
          {track.name}
        </span>
        <span className="pr-sep" />
        <span className={`pr-scope ${asset ? '' : 'ace-missing'}`} title="The audio file this clip plays">
          {asset ? `${asset.name} · ${asset.duration.toFixed(2)} s` : 'Source file missing'}
        </span>
        <span className="pr-space" />
        <div className="pr-group">
          <Button title="Cut the clip in two at the playhead (⌘E)" onClick={() => splitClips([clip.id], engine.getPosition())}>
            Split at playhead
          </Button>
          <Button title="Put a copy after it (⌘D)" onClick={() => duplicateClips([clip.id])}>
            Duplicate
          </Button>
          <Button kind="danger" onClick={() => removeClips([clip.id])}>
            Delete
          </Button>
        </div>
      </div>
      <div className="ace-body">
        <Waveform clip={clip} color={track.color} seconds={seconds} />
        <div className="ace-dials">
          <Dial label="Gain" min={0} max={2} reset={1} value={gain} text={`${decibels(gain)} dB`} onChange={(v) => set({ gain: v }, 'gain')} onEnd={endGesture} />
          <Dial
            label="Stretch: length without changing pitch"
            caption="Stretch"
            min={0.5}
            max={2}
            curve={STRETCH}
            reset={1}
            value={stretch}
            text={`${Math.round(stretch * 100)}%`}
            onChange={(v) => setClipStretch(clip.id, v, `clip-stretch-${clip.id}`)}
            onEnd={endGesture}
          />
          <Dial
            label="Pitch: shift without changing length"
            caption="Pitch"
            bipolar
            min={-12}
            max={12}
            snap={1}
            reset={0}
            value={pitch}
            text={`${pitch > 0 ? '+' : ''}${pitch} st`}
            onChange={(v) => set({ pitch: v }, 'pitch')}
            onEnd={endGesture}
          />
          {/* The two fades may not overlap. */}
          <Dial label="Fade in" min={0} max={seconds} reset={0} value={fadeIn} text={`${fadeIn.toFixed(2)} s`} onChange={(v) => set({ fadeIn: Math.min(v, seconds - fadeOut) }, 'fadein')} onEnd={endGesture} />
          <Dial label="Fade out" min={0} max={seconds} reset={0} value={fadeOut} text={`${fadeOut.toFixed(2)} s`} onChange={(v) => set({ fadeOut: Math.min(v, seconds - fadeIn) }, 'fadeout')} onEnd={endGesture} />
        </div>
      </div>
    </div>
  )
}

/** The clip's stretch of its file, drawn to fill the space, at the height its gain gives it. */
function Waveform({ clip, color, seconds }: { clip: AudioClip; color: string; seconds: number }): React.JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const head = useRef<HTMLDivElement>(null)
  const assetsVersion = useStudio((s) => s.assetsVersion)
  const [size, setSize] = useState({ width: 0, height: 0 })

  useEffect(() => {
    const el = box.current!
    const measure = (): void => setSize({ width: el.clientWidth, height: el.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [])

  const gain = clip.gain ?? 1
  const fadeIn = clip.fadeIn ?? 0
  const fadeOut = clip.fadeOut ?? 0
  const { stretch } = clipStretch(clip)
  useEffect(() => {
    const el = canvas.current
    const g = el?.getContext('2d')
    const { width, height } = size
    if (!el || !g || !width || !height) return
    const scale = el.ownerDocument.defaultView?.devicePixelRatio || 1
    el.width = width * scale
    el.height = height * scale
    g.scale(scale, scale)
    g.clearRect(0, 0, width, height)
    const info = assetInfo.get(clip.assetId)
    if (!info) return
    const mid = height / 2
    const count = info.peaks.length / 2
    // Each pixel column covers this much of the file.
    const step = seconds / stretch / width
    g.fillStyle = color
    for (let x = 0; x < width; x++) {
      const first = Math.floor((clip.offset + x * step) / info.secondsPerPeak)
      const to = Math.max(first + 1, Math.floor((clip.offset + (x + 1) * step) / info.secondsPerPeak))
      if (first >= count) break
      let min = 0
      let max = 0
      for (let i = Math.max(0, first); i < to && i < count; i++) {
        min = Math.min(min, info.peaks[i * 2])
        max = Math.max(max, info.peaks[i * 2 + 1])
      }
      const top = mid - Math.min(1, max * gain) * (mid - 4)
      g.fillRect(x, top, 1, Math.max(1, mid - Math.max(-1, min * gain) * (mid - 4) - top))
    }
    // Shade the fades.
    g.fillStyle = 'rgb(0 0 0 / 0.5)'
    const shade = (from: number, to: number): void => {
      g.beginPath()
      g.moveTo(from, 0)
      g.lineTo(to, 0)
      g.lineTo(from, height)
      g.fill()
    }
    if (fadeIn > 0) shade(0, (fadeIn / seconds) * width)
    if (fadeOut > 0) shade(width, width - (fadeOut / seconds) * width)
  }, [clip.assetId, clip.offset, seconds, stretch, gain, fadeIn, fadeOut, color, size, assetsVersion])

  useFrame(() => {
    const el = head.current
    if (!el) return
    const at = (engine.getPosition() - clip.start) / clip.length
    el.style.display = at >= 0 && at <= 1 ? 'block' : 'none'
    el.style.transform = `translateX(${at * size.width}px)`
  })

  const seek = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const startX = e.clientX
    const at = (x: number): number => {
      const rect = el.getBoundingClientRect()
      return clip.start + Math.min(1, Math.max(0, (x - rect.left) / rect.width)) * clip.length
    }
    engine.seek(at(startX))
    startDrag(e, (dx) => engine.seek(at(startX + dx)))
  }

  return (
    <div className="ace-wave" ref={box} onPointerDown={seek} title="Click to move the playhead">
      <canvas ref={canvas} style={{ width: size.width, height: size.height }} />
      {!assetInfo.get(clip.assetId) && <span className="ace-offline">Audio file offline</span>}
      <div className="ace-head" ref={head} />
    </div>
  )
}
