import { useRef } from 'react'
import type { Id, Track } from '@shared/model'
import { engine } from '../engine'
import { toggleArm } from '../recording'
import { updateTrack } from '../state/actions'
import { useStudio } from '../state/store'
import { useFrame } from '../util'
import { Toggle } from './controls/buttons'
import { Fader } from './controls/Fader'
import { Knob } from './controls/Knob'
import { useMenu } from './controls/Popover'
import { VOLUME_CURVE, VOLUME_TICKS, decibels, panText } from './mixing'
import { selectTrack, trackMenu } from './trackMenu'

const KIND: Record<Track['kind'], string> = { midi: 'Instrument', audio: 'Audio', bus: 'Bus' }

const endGesture = (): void => useStudio.getState().endGesture()

/** A peak meter that rises from the bottom, with a fast attack and slow fall. */
function LevelMeter({ target }: { target: Id | 'master' }): React.JSX.Element {
  const fill = useRef<HTMLDivElement>(null)
  const shown = useRef(0)
  useFrame(() => {
    const peak = engine.getPeak(target)
    // Map -48 dB…0 dB onto 0…1.
    const level = peak > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(peak) + 48) / 48)) : 0
    shown.current = Math.max(level, shown.current - 0.025)
    if (fill.current) fill.current.style.clipPath = `inset(${(1 - shown.current) * 100}% 0 0 0)`
  })
  return (
    <div className="level-meter">
      <div className="level-meter-fill" ref={fill} />
    </div>
  )
}

function Strip({ track }: { track: Track }): React.JSX.Element {
  const selected = useStudio((s) => s.selectedTrackId === track.id)
  const armed = useStudio((s) => s.armedTrackId === track.id)
  const [menu, openMenu] = useMenu()
  return (
    <div
      className={`strip ${selected ? 'selected' : ''}`}
      onPointerDown={() => selectTrack(track)}
      onContextMenu={(event) => openMenu(event, trackMenu(track))}
    >
      <div className="strip-kind">{KIND[track.kind]}</div>
      <div className="strip-pan">
        <Knob
          label="Pan"
          bipolar
          min={-1}
          max={1}
          snap={0.05}
          reset={0}
          value={track.pan}
          text={panText(track.pan)}
          onChange={(pan) => updateTrack(track.id, { pan }, `pan-${track.id}`)}
          onEnd={endGesture}
        />
        <output>{panText(track.pan)}</output>
      </div>
      <div className="strip-fader">
        <Fader
          label="Volume"
          min={0}
          max={1.5}
          reset={0.8}
          curve={VOLUME_CURVE}
          ticks={VOLUME_TICKS}
          value={track.volume}
          text={`${decibels(track.volume)} dB`}
          onChange={(volume) => updateTrack(track.id, { volume }, `volume-${track.id}`)}
          onEnd={endGesture}
        />
        <LevelMeter target={track.id} />
      </div>
      <output className="strip-level">{decibels(track.volume)} dB</output>
      <div className="strip-buttons">
        <Toggle label="Mute" tone="warn" size="sm" pressed={track.mute} onChange={(mute) => updateTrack(track.id, { mute })}>
          M
        </Toggle>
        <Toggle label="Solo" tone="accent" size="sm" pressed={track.solo} onChange={(solo) => updateTrack(track.id, { solo })}>
          S
        </Toggle>
        {track.kind !== 'bus' && (
          <Toggle label="Arm for recording" tone="danger" size="sm" pressed={armed} onChange={() => void toggleArm(track.id)}>
            R
          </Toggle>
        )}
      </div>
      <div className="strip-name" title={track.name}>
        <span className="strip-color" style={{ background: track.color }} />
        <span>{track.name}</span>
      </div>
      {menu}
    </div>
  )
}

/** The dock's Mixer tab: a channel strip for every track, buses after the rest, and the master level at the end. */
export function Mixer(): React.JSX.Element {
  const tracks = useStudio((s) => s.project.tracks)
  const ordered = [...tracks.filter((t) => t.kind !== 'bus'), ...tracks.filter((t) => t.kind === 'bus')]
  return (
    <div className="mixer">
      <div className="mixer-strips">
        {ordered.map((track) => (
          <Strip key={track.id} track={track} />
        ))}
        {tracks.length === 0 && <p className="muted mixer-empty">Add a track to get started.</p>}
      </div>
      <div className="strip master-strip">
        <div className="strip-kind">Output</div>
        <div className="strip-fader">
          <LevelMeter target="master" />
        </div>
        <div className="strip-name">
          <span>Master</span>
        </div>
      </div>
    </div>
  )
}
