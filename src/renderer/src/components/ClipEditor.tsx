import { engine } from '../engine'
import { duplicateClips, findClip, removeClips, splitClips } from '../state/actions'
import { useStudio } from '../state/store'
import { AudioClipEditor } from './AudioClipEditor'
import { Button } from './controls/buttons'
import { PianoRoll } from './PianoRoll'

/** The dock's Editor tab: the piano roll for a MIDI clip, the waveform and settings for an audio clip. */
export function ClipEditor(): React.JSX.Element {
  const project = useStudio((s) => s.project)
  const selectedClipIds = useStudio((s) => s.selectedClipIds)
  const found = findClip(project, selectedClipIds[selectedClipIds.length - 1])

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
  if (found?.clip.kind === 'midi') return <PianoRoll track={found.track} clip={found.clip} />
  if (found) return <AudioClipEditor track={found.track} clip={found.clip} />
  return (
    <div className="ce-empty">
      <p className="ce-title">No clip selected</p>
      <p>Select a clip in the arrangement to edit it here.</p>
      <p>To make one, double-click an instrument track's lane, or drop audio files onto the arrangement.</p>
    </div>
  )
}
