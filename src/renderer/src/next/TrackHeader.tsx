import { AUTOMATION_RANGE, type Track } from '@shared/model'
import { Meter, TextField } from '../components/controls'
import { toggleArm } from '../recording'
import { updateTrack } from '../state/actions'
import { useStudio } from '../state/store'
import { IconButton, Toggle } from './controls/buttons'
import { Knob } from './controls/Knob'
import { Caret, useMenu } from './controls/Popover'
import { VOLUME_CURVE, decibels, panText } from './mixing'
import { HEADER_WIDTH } from './layout'
import { automationItems, selectTrack, trackMenu } from './trackMenu'

const endGesture = (): void => useStudio.getState().endGesture()

/**
 * A track's header at the left of its row in the arrangement. The name and
 * mute, solo and arm on top; volume and pan as small knobs with their values
 * beneath, beside the choice of automation lane; the level along the bottom.
 * Deleting is not a button here: it is in the menu (the ⋯ button, or a
 * right-click anywhere on the header), with the rest of what a track can do.
 */
export function TrackHeader({ track }: { track: Track }): React.JSX.Element {
  const selected = useStudio((s) => s.selectedTrackId === track.id)
  const armed = useStudio((s) => s.armedTrackId === track.id)
  const automation = useStudio((s) => s.automationLanes[track.id])
  const [menu, openMenu] = useMenu()
  return (
    <div className={`th ${selected ? 'selected' : ''}`} style={{ width: HEADER_WIDTH }} onPointerDown={() => selectTrack(track)} onContextMenu={(event) => openMenu(event, trackMenu(track))}>
      <div className="th-color" style={{ background: track.color }} />
      <div className="th-main">
        <div className="th-row">
          <TextField className="th-name" label="Track name" value={track.name} onCommit={(name) => name.trim() && updateTrack(track.id, { name: name.trim() })} />
          <Toggle label="Mute" tone="warn" size="sm" pressed={track.mute} onChange={(mute) => updateTrack(track.id, { mute })}>
            M
          </Toggle>
          <Toggle label="Solo" tone="accent" size="sm" pressed={track.solo} onChange={(solo) => updateTrack(track.id, { solo })}>
            S
          </Toggle>
          {track.kind !== 'bus' ? (
            <Toggle label="Arm for recording" tone="danger" size="sm" pressed={armed} onChange={() => void toggleArm(track.id)}>
              R
            </Toggle>
          ) : (
            // Keeps mute and solo in the same columns as on the other tracks.
            <span className="th-gap" />
          )}
          <IconButton label="More: automation, reset, delete" size="sm" onClick={(event) => openMenu(event, trackMenu(track))}>
            <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor" aria-hidden>
              <circle cx="2" cy="6" r="1.1" />
              <circle cx="6" cy="6" r="1.1" />
              <circle cx="10" cy="6" r="1.1" />
            </svg>
          </IconButton>
        </div>
        <div className="th-row">
          <Knob
            label="Volume"
            size={22}
            min={0}
            max={1.5}
            curve={VOLUME_CURVE}
            reset={0.8}
            value={track.volume}
            text={`${decibels(track.volume)} dB`}
            onChange={(volume) => updateTrack(track.id, { volume }, `volume-${track.id}`)}
            onEnd={endGesture}
          />
          <output className="th-level">{decibels(track.volume)} dB</output>
          <Knob
            label="Pan"
            size={22}
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
          <output className="th-pan">{panText(track.pan)}</output>
          <span className="th-space" />
          <button
            type="button"
            className={`th-auto ${automation ? 'on' : ''}`}
            title={`Automation lane: ${automation ? AUTOMATION_RANGE[automation].label.toLowerCase() : 'none'} (click to choose)`}
            aria-haspopup="menu"
            onClick={(event) => openMenu(event, automationItems(track))}
          >
            {automation ? AUTOMATION_RANGE[automation].label : 'Auto'}
            <Caret />
          </button>
        </div>
        <Meter target={track.id} />
      </div>
      {menu}
    </div>
  )
}
