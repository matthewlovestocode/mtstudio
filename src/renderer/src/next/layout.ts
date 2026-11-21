import { create } from 'zustand'
import { PPQ } from '@shared/model'

/** The panels around the arrangement: which are open, how big, and what the dock shows. Remembered between sessions. */
export type DockTab = 'editor' | 'mixer' | 'kit'

export interface Layout {
  sideOpen: boolean
  sideWidth: number
  dockOpen: boolean
  dockHeight: number
  dockTab: DockTab
  /** What drags in the arrangement line up with: a number of ticks, `SNAP_BAR` or `SNAP_OFF`. */
  snap: number
  /** Whether the tempo, signature and marker rows are showing. */
  globals: boolean
  /** The piano roll's horizontal zoom, in pixels per beat. */
  rollZoom: number
}

export const ROLL_ZOOM = { min: 24, max: 384, default: 96 }

export const SNAP_OFF = 0
export const SNAP_BAR = -1
export const SNAP_OPTIONS: [number, string][] = [
  [SNAP_BAR, 'Bar'],
  [PPQ, '1/4'],
  [PPQ / 2, '1/8'],
  [PPQ / 4, '1/16'],
  [PPQ / 8, '1/32'],
  [SNAP_OFF, 'Off']
]

/** The width of the track headers down the left of the arrangement. */
export const HEADER_WIDTH = 236

export const SIDE = { min: 220, max: 420, default: 264 }
export const DOCK = { min: 140, default: 300 }
/** The least of the arrangement that the dock must leave showing. */
export const ARRANGE_MIN = 120

const KEY = 'studio.next.layout'
const DEFAULTS: Layout = { sideOpen: true, sideWidth: SIDE.default, dockOpen: true, dockHeight: DOCK.default, dockTab: 'editor', snap: PPQ, globals: true, rollZoom: ROLL_ZOOM.default }

function stored(): Layout {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Layout>) }
  } catch {
    return DEFAULTS
  }
}

export const useLayout = create<Layout>(() => stored())

export function setLayout(patch: Partial<Layout>): void {
  useLayout.setState(patch)
  try {
    localStorage.setItem(KEY, JSON.stringify(useLayout.getState()))
  } catch {
    // Not remembered; the layout still holds for this session.
  }
}

/** Shows a tab of the dock; choosing the one already showing folds the dock away. */
export function showDock(tab: DockTab): void {
  const { dockOpen, dockTab } = useLayout.getState()
  setLayout(dockOpen && dockTab === tab ? { dockOpen: false } : { dockOpen: true, dockTab: tab })
}

/** The panels that can be brought out into a window of their own. */
export type PanelId = 'inspector' | DockTab

/** Which panels are out in their own windows. Not remembered: the windows do not outlive the page. */
export const useFloating = create<Record<PanelId, boolean>>(() => ({ inspector: false, editor: false, mixer: false, kit: false }))

export function setFloating(panel: PanelId, floating: boolean): void {
  useFloating.setState({ [panel]: floating })
  // Coming back, a panel is shown, not left folded away.
  if (!floating) setLayout(panel === 'inspector' ? { sideOpen: true } : { dockOpen: true, dockTab: panel })
}
