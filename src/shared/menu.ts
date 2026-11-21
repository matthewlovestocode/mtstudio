/**
 * The app's name and its menu commands, in one place: the main process builds
 * the application menu from this, and the renderer uses it for the in-window
 * menus and (in a plain browser tab) for keyboard shortcuts.
 */

export const APP_NAME = 'mtstudio'

/** The start of the name of every window that holds a panel brought out of the main window. The main process lets the page open these and nothing else. */
export const PANEL_WINDOW_PREFIX = 'studio-panel-'

export type MenuCommand =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'undo'
  | 'redo'
  | 'importAudio'
  | 'export'
  | 'split'
  | 'addInstrumentTrack'
  | 'addAudioTrack'
  | 'addBus'

export interface MenuEntry {
  command: MenuCommand
  label: string
  /** An Electron accelerator made of Shift, Alt, CmdOrCtrl and one key, e.g. `Shift+CmdOrCtrl+S`. */
  accelerator: string
}

export interface MenuSection {
  label: string
  /** `null` is a separator line. */
  items: (MenuEntry | null)[]
}

export const TRACK_MENU: MenuSection = {
  label: 'Track',
  items: [
    { command: 'addInstrumentTrack', label: 'New Instrument Track', accelerator: 'Shift+CmdOrCtrl+T' },
    { command: 'addAudioTrack', label: 'New Audio Track', accelerator: 'CmdOrCtrl+T' },
    { command: 'addBus', label: 'New Bus', accelerator: 'Alt+CmdOrCtrl+T' }
  ]
}

const IMPORT_AUDIO: MenuEntry = { command: 'importAudio', label: 'Import Audio…', accelerator: 'CmdOrCtrl+I' }

export const MENUS: MenuSection[] = [
  {
    label: 'File',
    items: [
      { command: 'new', label: 'New Project', accelerator: 'CmdOrCtrl+N' },
      { command: 'open', label: 'Open…', accelerator: 'CmdOrCtrl+O' },
      null,
      { command: 'save', label: 'Save', accelerator: 'CmdOrCtrl+S' },
      { command: 'saveAs', label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S' },
      null,
      IMPORT_AUDIO,
      { command: 'export', label: 'Export Mixdown…', accelerator: 'Shift+CmdOrCtrl+E' }
    ]
  },
  {
    label: 'Edit',
    items: [
      { command: 'undo', label: 'Undo', accelerator: 'CmdOrCtrl+Z' },
      { command: 'redo', label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z' },
      null,
      { command: 'split', label: 'Split at Playhead', accelerator: 'CmdOrCtrl+E' }
    ]
  },
  TRACK_MENU
]

/** What the "+ Track" button in the transport bar offers. */
export const ADD_MENU: MenuSection[] = [{ label: 'Add', items: [...TRACK_MENU.items, null, IMPORT_AUDIO] }]

interface KeyLike {
  key: string
  code: string
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
  ctrlKey: boolean
}

/** Whether a key press is the given accelerator. */
export function matchesAccelerator(event: KeyLike, accelerator: string): boolean {
  const parts = accelerator.split('+')
  const key = parts[parts.length - 1]
  // `code` as well as `key`: with Alt held, macOS turns the letter into a symbol.
  const pressed = event.key.toUpperCase() === key || event.code === `Key${key}`
  return (
    pressed &&
    (event.metaKey || event.ctrlKey) === parts.includes('CmdOrCtrl') &&
    event.shiftKey === parts.includes('Shift') &&
    event.altKey === parts.includes('Alt')
  )
}

/** An accelerator as shown to the user: `⇧⌘S` on a Mac, `Ctrl+Shift+S` elsewhere. */
export function acceleratorLabel(accelerator: string, mac: boolean): string {
  const parts = accelerator.split('+')
  const key = parts[parts.length - 1]
  const has = (part: string): boolean => parts.includes(part)
  if (mac) return `${has('Alt') ? '⌥' : ''}${has('Shift') ? '⇧' : ''}${has('CmdOrCtrl') ? '⌘' : ''}${key}`
  return [has('CmdOrCtrl') && 'Ctrl', has('Alt') && 'Alt', has('Shift') && 'Shift', key].filter(Boolean).join('+')
}
