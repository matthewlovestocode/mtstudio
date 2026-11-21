import { create } from 'zustand'

/**
 * Which interface the window shows: the one in use, or the reworked one being
 * built in this folder. Both sit on the same store and engine, so switching
 * keeps the project, the selection and the playhead, and the two can be
 * compared on the same material.
 *
 * The address says which: `#preview` is the reworked interface and `#current`
 * the one in use, so either can be opened directly or kept in a tab of its
 * own. With neither in the address, the last choice is used.
 */
export type Ui = 'current' | 'next'

const KEY = 'studio.ui'
const HASH: Record<Ui, string> = { current: '#current', next: '#preview' }

function fromAddress(): Ui | null {
  const { hash } = window.location
  return hash === HASH.next ? 'next' : hash === HASH.current ? 'current' : null
}

function stored(): Ui {
  try {
    return localStorage.getItem(KEY) === 'next' ? 'next' : 'current'
  } catch {
    return 'current'
  }
}

export const usePreview = create<{ ui: Ui }>(() => ({ ui: fromAddress() ?? stored() }))

function remember(ui: Ui): void {
  try {
    localStorage.setItem(KEY, ui)
  } catch {
    // Not remembered; the switch still works for this session.
  }
}

export function setUi(ui: Ui): void {
  usePreview.setState({ ui })
  remember(ui)
  // Replaced rather than pushed, so switching back and forth does not fill the history.
  if (window.location.hash !== HASH[ui]) window.history.replaceState(null, '', HASH[ui])
}

export function toggleUi(): void {
  setUi(usePreview.getState().ui === 'next' ? 'current' : 'next')
}

// Typing an address, or following a link to one, switches too.
window.addEventListener('hashchange', () => {
  const ui = fromAddress()
  if (ui && ui !== usePreview.getState().ui) {
    usePreview.setState({ ui })
    remember(ui)
  }
})
// Show where we are from the start.
if (!fromAddress()) window.history.replaceState(null, '', HASH[usePreview.getState().ui])
