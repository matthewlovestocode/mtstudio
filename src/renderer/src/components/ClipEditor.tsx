import { engine } from '../engine'
import { duplicateClips, findClip, removeClips, splitClips } from '../state/actions'
import { useStudio } from '../state/store'
import { AudioClipEditor } from './AudioClipEditor'
import { isDrumTrack } from '../drums'
import { Button, Segmented } from './controls/buttons'
import { useClipView } from './layout'
import { PianoRoll } from './PianoRoll'
import { StepSequencer } from './StepSequencer'

/**
 * The dock's Editor tab. A MIDI clip opens in the step sequencer if its
 * track is drums and in the piano roll otherwise, with a switch between the
 * two that is remembered for the track; an audio clip shows its waveform
 * and settings.
 */
export function ClipEditor(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const selectedClipIds = useStudio((s) => s.selectedClipIds)
  const found = findClip(project, selectedClipIds[selectedClipIds.length - 1])
  const chosenView = useClipView((s) => (found ? s[found.track.id] : undefined))

  if (selectedClipIds.length > 1)
    return (
      <div className="ce-empty">
        <p className="ce-title">{selectedClipIds.length} clips selected</p>
        <div className="pr-group">
          <Button title="Cut each in two at the playhead (⌘E)" onClick={() => splitClips(selectedClipIds, engine.getPosition())}>
            Split at playhead
          </Button>
          <Button title="Put a copy after each (⌘D)" onClick={() => duplicateClips(selectedClipIds)}>
            Duplicate
          </Button>
          <Button kind="danger" onClick={() => removeClips(selectedClipIds)}>
            Delete
          </Button>
        </div>
        <p>Select one clip to edit its notes or audio.</p>
      </div>
    )
  if (found?.clip.kind === 'midi') {
    const { track, clip } = found
    const view = chosenView ?? (isDrumTrack(track) ? 'steps' : 'roll')
    const viewSwitch = (
      <Segmented
        label="Editor"
        value={view}
        options={[
          ['steps', 'Steps'],
          ['roll', 'Piano roll']
        ]}
        onChange={(next) => useClipView.setState({ [track.id]: next })}
      />
    )
    return view === 'steps' ? <StepSequencer track={track} clip={clip} viewSwitch={viewSwitch} /> : <PianoRoll track={track} clip={clip} viewSwitch={viewSwitch} />
  }
  if (found) return <AudioClipEditor track={found.track} clip={found.clip} />
  return (
    <div className="ce-empty">
      <p className="ce-title">No clip selected</p>
      <p>Select a clip in the arrangement to edit it here.</p>
      <p>To make one, double-click an instrument track's lane, or drop audio files onto the arrangement.</p>
    </div>
  )
}
