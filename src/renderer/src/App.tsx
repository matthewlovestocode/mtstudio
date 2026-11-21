import { useEffect } from 'react'
import { MENUS, matchesAccelerator } from '@shared/menu'
import { Shell } from './components/Shell'
import { engine } from './engine'
import { bridge, runCommand } from './platform'
import { togglePlay, toggleRecord } from './recording'
import { addMarker, duplicateClips, findClip, removeClips, removeNotes, transposeNotes } from './state/actions'
import { useStudio } from './state/store'
import { isTyping } from './util'

export function App(): React.JSX.Element {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey
      const key = e.key.toLowerCase()

      // In Electron these arrive through the application menu instead. (A
      // browser keeps a few for itself, such as Cmd-N and Cmd-T; the Menu
      // button in the transport bar reaches those.)
      const shortcut = !bridge && mod ? MENUS.flatMap((section) => section.items).find((item) => item && matchesAccelerator(e, item.accelerator)) : null
      if (shortcut) {
        e.preventDefault()
        runCommand(shortcut.command)
        return
      }
      if (isTyping(e.target)) return

      const { selectedClipIds, selectedNoteIds, project } = useStudio.getState()
      // With notes selected in the piano roll, Delete and the arrow keys act on them rather than on the clip.
      const open = findClip(project, selectedClipIds[selectedClipIds.length - 1])?.clip
      const notes = open?.kind === 'midi' && selectedClipIds.length === 1 ? selectedNoteIds.filter((id) => open.notes.some((n) => n.id === id)) : []
      if (open && notes.length && ['delete', 'backspace', 'arrowup', 'arrowdown'].includes(key)) {
        e.preventDefault()
        if (key === 'arrowup' || key === 'arrowdown') transposeNotes(open.id, notes, (key === 'arrowup' ? 1 : -1) * (e.shiftKey ? 12 : 1))
        else removeNotes(open.id, notes)
        return
      }
      if (e.code === 'Space') {
        e.preventDefault()
        togglePlay()
      } else if (key === 'r' && !mod) {
        void toggleRecord()
      } else if (key === 'm' && !mod) {
        addMarker(engine.getPosition())
      } else if (key === 'home' || key === 'enter') {
        engine.seek(0)
      } else if ((key === 'delete' || key === 'backspace') && selectedClipIds.length) {
        e.preventDefault()
        removeClips(selectedClipIds)
      } else if (mod && key === 'd' && selectedClipIds.length) {
        e.preventDefault()
        duplicateClips(selectedClipIds)
      }
    }
    // Stops a focused button from also firing when Space toggles playback.
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === 'Space' && !isTyping(e.target)) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  return <Shell />
}
