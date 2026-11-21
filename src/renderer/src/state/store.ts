import { create } from 'zustand'
import { PPQ, type AutomationTarget, type Id, type Project } from '@shared/model'
import type { AssetInfo } from '../engine/types'
import { demoProject } from './demo'

const HISTORY_LIMIT = 200
/** Timeline zoom limits, in pixels per quarter note. */
export const MIN_ZOOM = 3
export const MAX_ZOOM = 320

export interface StudioState {
  project: Project
  past: Project[]
  future: Project[]
  /** Identifies an in-progress drag so its many small edits become one undo step. */
  gesture: string | null

  selectedTrackId: Id | null
  /** Selected clips; the last one is the primary selection shown in the editor. */
  selectedClipIds: Id[]
  /** Notes selected in the piano roll. */
  selectedNoteIds: Id[]
  /** Keep the playhead in view while playing. */
  follow: boolean
  playing: boolean
  metronome: boolean
  /** The track that records. */
  armedTrackId: Id | null
  /** Set while recording: where the take began. */
  recordingFrom: number | null
  /** Hear the audio input through the armed track. */
  monitor: boolean
  /** Play notes from the computer keyboard. */
  typingKeys: boolean
  /** Tracks showing an automation curve over their lane, and which one. */
  automationLanes: Record<Id, AutomationTarget>
  /** Timeline zoom. */
  pxPerBeat: number
  /** Note grid in ticks. */
  snap: number
  filePath: string | null
  dirty: boolean
  /** Bumped when waveform data arrives, so clips redraw. */
  assetsVersion: number

  /** Apply a change to the project, recording it for undo. */
  edit(change: (project: Project) => Project, gesture?: string): void
  endGesture(): void
  undo(): void
  redo(): void
  loadProject(project: Project, filePath: string | null): void
}

export const useStudio = create<StudioState>((set, get) => ({
  project: demoProject(),
  past: [],
  future: [],
  gesture: null,
  selectedTrackId: null,
  selectedClipIds: [],
  selectedNoteIds: [],
  follow: true,
  playing: false,
  metronome: false,
  armedTrackId: null,
  recordingFrom: null,
  monitor: false,
  typingKeys: true,
  automationLanes: {},
  pxPerBeat: 40,
  snap: PPQ / 4,
  filePath: null,
  dirty: false,
  assetsVersion: 0,

  edit(change, gesture) {
    const state = get()
    const next = change(state.project)
    if (next === state.project) return
    const continuing = gesture !== undefined && gesture === state.gesture
    set({
      project: next,
      past: continuing ? state.past : [...state.past, state.project].slice(-HISTORY_LIMIT),
      future: [],
      gesture: gesture ?? null,
      dirty: true
    })
  },

  endGesture() {
    set({ gesture: null })
  },

  undo() {
    const { past, future, project } = get()
    if (!past.length) return
    set({ project: past[past.length - 1], past: past.slice(0, -1), future: [project, ...future], gesture: null, dirty: true })
  },

  redo() {
    const { past, future, project } = get()
    if (!future.length) return
    set({ project: future[0], past: [...past, project], future: future.slice(1), gesture: null, dirty: true })
  },

  loadProject(project, filePath) {
    set({
      project,
      filePath,
      past: [],
      future: [],
      gesture: null,
      dirty: false,
      selectedClipIds: [],
      armedTrackId: null,
      selectedTrackId: project.tracks[0]?.id ?? null
    })
  }
}))

/** Waveform data per asset. Kept out of the store: it is large and never edited. */
export const assetInfo = new Map<Id, AssetInfo>()
