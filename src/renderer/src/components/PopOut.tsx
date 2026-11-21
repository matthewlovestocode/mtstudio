import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { APP_NAME, PANEL_WINDOW_PREFIX } from '@shared/menu'
import { isTyping } from '../util'

/**
 * Shows its children in a window of their own. The window is an empty one
 * that this page fills in, so what is inside is still part of this page: the
 * same store, the same engine, the same React tree. Closing the window, by
 * its own close button or because this component goes, calls `onClose`.
 */
export function PopOut(props: {
  /** Names the window, so that asking for the same panel twice gives one window. */
  name: string
  title: string
  width: number
  height: number
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element | null {
  const [container, setContainer] = useState<HTMLElement | null>(null)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  useEffect(() => {
    const left = window.screenX + Math.max(0, (window.outerWidth - props.width) / 2)
    const top = window.screenY + Math.max(0, (window.outerHeight - props.height) / 2)
    const win = window.open('', PANEL_WINDOW_PREFIX + props.name, `popup,width=${props.width},height=${props.height},left=${Math.round(left)},top=${Math.round(top)}`)
    if (!win) {
      // Refused (a browser's pop-up blocker): the panel stays where it was.
      onClose.current()
      return
    }
    // Written out so the window is in standards mode, as the main one is.
    win.document.open()
    win.document.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
    win.document.close()
    win.document.title = `${props.title} — ${APP_NAME}`

    // The window has this page's styles, kept in step as they change (in development they are edited live).
    const copyStyles = (): void => {
      win.document.head.querySelectorAll('[data-copied]').forEach((node) => node.remove())
      document.head.querySelectorAll('style, link[rel="stylesheet"]').forEach((node) => {
        const copy = win.document.importNode(node, true) as HTMLElement
        copy.setAttribute('data-copied', '')
        win.document.head.appendChild(copy)
      })
    }
    copyStyles()
    const styles = new MutationObserver(copyStyles)
    styles.observe(document.head, { childList: true, subtree: true, characterData: true })

    // Shortcuts are listened for on the main window, so keys pressed here are passed on to it.
    const forward = (event: KeyboardEvent): void => {
      if (isTyping(event.target)) return
      const copy = new KeyboardEvent(event.type, { ...keyInit(event), cancelable: true })
      window.dispatchEvent(copy)
      if (copy.defaultPrevented) event.preventDefault()
    }
    win.addEventListener('keydown', forward)
    win.addEventListener('keyup', forward)

    const root = win.document.createElement('div')
    root.className = 'studio popout'
    win.document.body.appendChild(root)
    setContainer(root)

    const closed = (): void => onClose.current()
    win.addEventListener('pagehide', closed)
    // The panel windows go when the main one does (or reloads).
    const closeWithPage = (): void => win.close()
    window.addEventListener('pagehide', closeWithPage)
    return () => {
      styles.disconnect()
      win.removeEventListener('pagehide', closed)
      window.removeEventListener('pagehide', closeWithPage)
      setContainer(null)
      win.close()
    }
    // The window is opened once; its size afterwards is the user's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.name])

  return container && createPortal(props.children, container)
}

function keyInit(event: KeyboardEvent): KeyboardEventInit {
  const { key, code, location, repeat, ctrlKey, shiftKey, altKey, metaKey, bubbles } = event
  return { key, code, location, repeat, ctrlKey, shiftKey, altKey, metaKey, bubbles }
}
