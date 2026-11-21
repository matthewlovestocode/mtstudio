import { AUTOMATION_RANGE, type AutomationTarget, type Track } from '@shared/model'
import { toggleArm } from '../recording'
import { removeTrack, updateTrack } from '../state/actions'
import { useStudio } from '../state/store'
import type { MenuItem } from './controls/Popover'

/** Shows a track's automation lane for `target` over its clips, or none. */
export function showAutomation(trackId: string, target: AutomationTarget | undefined): void {
  useStudio.setState((s) => {
    const lanes = { ...s.automationLanes }
    if (target) lanes[trackId] = target
    else delete lanes[trackId]
    return { automationLanes: lanes }
  })
}

export function automationItems(track: Track): MenuItem[] {
  const shown = useStudio.getState().automationLanes[track.id]
  return [
    { heading: 'Automation lane' },
    { label: 'None', checked: shown === undefined, onSelect: () => showAutomation(track.id, undefined) },
    ...(Object.keys(AUTOMATION_RANGE) as AutomationTarget[]).map((target) => ({
      label: AUTOMATION_RANGE[target].label,
      checked: shown === target,
      onSelect: () => showAutomation(track.id, target)
    }))
  ]
}

/** What a right-click on a track offers, wherever the track is shown: its header in the arrangement, its strip in the mixer. */
export function trackMenu(track: Track): MenuItem[] {
  const armed = useStudio.getState().armedTrackId === track.id
  return [
    { heading: track.name },
    { label: 'Mute', checked: track.mute, onSelect: () => updateTrack(track.id, { mute: !track.mute }) },
    { label: 'Solo', checked: track.solo, onSelect: () => updateTrack(track.id, { solo: !track.solo }) },
    ...(track.kind !== 'bus' ? [{ label: 'Arm for Recording', checked: armed, onSelect: () => void toggleArm(track.id) }] : []),
    { separator: true },
    ...automationItems(track),
    { separator: true },
    { label: 'Reset Volume', onSelect: () => updateTrack(track.id, { volume: 0.8 }) },
    { label: 'Centre Pan', onSelect: () => updateTrack(track.id, { pan: 0 }) },
    { separator: true },
    { label: 'Delete Track', danger: true, onSelect: () => removeTrack(track.id) }
  ]
}

/** Picking a track also drops clips selected on other tracks, so the inspector shows this one. */
export function selectTrack(track: Track): void {
  useStudio.setState((state) => ({
    selectedTrackId: track.id,
    selectedClipIds: state.selectedClipIds.filter((id) => track.clips.some((c) => c.id === id))
  }))
}
