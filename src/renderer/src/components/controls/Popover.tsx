import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Where a pop-up appears: under an element, or at a point (a right-click). `el` also says which window it belongs to. */
export type Origin = { el: Element; x?: number; y?: number }

const MARGIN = 8

/**
 * A floating layer: the base of menus and pickers. It is drawn in the window
 * its origin is in (which may be a panel's own window), kept on screen, and
 * closed by Escape, by a click anywhere else, or when the window loses focus.
 */
export function Popover(props: { origin: Origin; onClose: () => void; className?: string; children: React.ReactNode }): React.JSX.Element {
  const { origin } = props
  const doc = origin.el.ownerDocument
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const onClose = useRef(props.onClose)
  onClose.current = props.onClose

  useLayoutEffect(() => {
    const view = doc.defaultView!
    const size = box.current!.getBoundingClientRect()
    const anchor = origin.el.getBoundingClientRect()
    const atPoint = origin.x !== undefined && origin.y !== undefined
    let left = atPoint ? origin.x! : anchor.left
    let top = atPoint ? origin.y! : anchor.bottom + 4
    // No room below: go above instead.
    if (top + size.height > view.innerHeight - MARGIN) top = (atPoint ? origin.y! : anchor.top - 4) - size.height
    left = Math.max(MARGIN, Math.min(left, view.innerWidth - size.width - MARGIN))
    top = Math.max(MARGIN, Math.min(top, view.innerHeight - size.height - MARGIN))
    setPlace({ left, top })
  }, [doc, origin])

  useEffect(() => {
    const view = doc.defaultView!
    const close = (): void => onClose.current()
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node
      // A button that opens a pop-up under itself also closes it: leave that press to the button.
      if (origin.x === undefined && origin.el.contains(target)) return
      if (!box.current?.contains(target)) close()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      close()
      ;(origin.el as HTMLElement).focus?.()
    }
    view.addEventListener('pointerdown', onPointerDown, true)
    view.addEventListener('keydown', onKeyDown, true)
    view.addEventListener('resize', close)
    view.addEventListener('blur', close)
    return () => {
      view.removeEventListener('pointerdown', onPointerDown, true)
      view.removeEventListener('keydown', onKeyDown, true)
      view.removeEventListener('resize', close)
      view.removeEventListener('blur', close)
    }
  }, [doc, origin])

  return createPortal(
    // The layer carries `studio` so the tokens reach a pop-up, which is drawn outside the app's own element.
    <div className="studio pop-layer">
      <div
        ref={box}
        className={`pop ${props.className ?? ''}`}
        // Unseen until it has been measured and placed, but not hidden: what is inside must be able to take the focus at once.
        style={place ?? { left: 0, top: 0, opacity: 0 }}
        // A pop-up is its own place: what happens inside it is not also a click or key press on what is underneath.
        onPointerDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        {props.children}
      </div>
    </div>,
    doc.body
  )
}

// ── Menus ────────────────────────────────────────────────────────────────

export type MenuItem =
  | { label: string; onSelect: () => void; shortcut?: string; disabled?: boolean; danger?: boolean; checked?: boolean }
  | { separator: true }
  | { heading: string }

/** A list of commands in a pop-up. Arrow keys move, Enter chooses, Escape closes. */
export function Menu(props: { origin: Origin; items: MenuItem[]; onClose: () => void }): React.JSX.Element {
  const list = useRef<HTMLDivElement>(null)
  const buttons = (): HTMLButtonElement[] => [...(list.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
  useEffect(() => {
    buttons()[0]?.focus()
  }, [])

  const onKeyDown = (event: React.KeyboardEvent): void => {
    const all = buttons()
    const at = all.indexOf(list.current!.ownerDocument.activeElement as HTMLButtonElement)
    let next = -1
    if (event.key === 'ArrowDown') next = (at + 1) % all.length
    else if (event.key === 'ArrowUp') next = (at - 1 + all.length) % all.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = all.length - 1
    else if (event.key === 'Tab') props.onClose()
    // Nothing typed in a menu is a shortcut for the app behind it.
    event.stopPropagation()
    if (next < 0) return
    event.preventDefault()
    all[next]?.focus()
  }

  const checks = props.items.some((item) => 'checked' in item && item.checked !== undefined)
  return (
    <Popover origin={props.origin} onClose={props.onClose} className="menu">
      <div ref={list} role="menu" onKeyDown={onKeyDown} onKeyUp={(e) => e.stopPropagation()}>
        {props.items.map((item, index) =>
          'separator' in item ? (
            <div key={index} className="menu-rule" role="separator" />
          ) : 'heading' in item ? (
            <div key={index} className="menu-head">
              {item.heading}
            </div>
          ) : (
            <button
              key={index}
              type="button"
              role={item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
              aria-checked={item.checked}
              className={`menu-row ${item.danger ? 'danger' : ''}`}
              disabled={item.disabled}
              onPointerEnter={(e) => e.currentTarget.focus()}
              onClick={() => {
                props.onClose()
                item.onSelect()
              }}
            >
              {checks && <span className="menu-check">{item.checked ? '✓' : ''}</span>}
              <span className="menu-label">{item.label}</span>
              {item.shortcut && <span className="menu-keys">{item.shortcut}</span>}
            </button>
          )
        )}
      </div>
    </Popover>
  )
}

/**
 * A menu opened from code, most often by a right-click:
 *
 *     const [menu, openMenu] = useMenu()
 *     <div onContextMenu={(e) => openMenu(e, [{ label: 'Delete', onSelect: remove }])}>…{menu}</div>
 */
export function useMenu(): [React.ReactNode, (event: React.MouseEvent, items: MenuItem[]) => void] {
  const [open, setOpen] = useState<{ origin: Origin; items: MenuItem[] } | null>(null)
  const show = (event: React.MouseEvent, items: MenuItem[]): void => {
    event.preventDefault()
    event.stopPropagation()
    setOpen({ origin: { el: event.currentTarget, x: event.clientX, y: event.clientY }, items })
  }
  return [open && <Menu origin={open.origin} items={open.items} onClose={() => setOpen(null)} />, show]
}

/** A button that opens a menu under itself. */
export function MenuButton(props: { label: string; title?: string; items: MenuItem[] }): React.JSX.Element {
  const [origin, setOrigin] = useState<Origin | null>(null)
  return (
    <>
      <button
        type="button"
        className={`btn btn-plain btn-menu ${origin ? 'open' : ''}`}
        title={props.title}
        aria-haspopup="menu"
        aria-expanded={!!origin}
        onClick={(e) => setOrigin(origin ? null : { el: e.currentTarget })}
      >
        {props.label}
        <Caret />
      </button>
      {origin && <Menu origin={origin} items={props.items} onClose={() => setOrigin(null)} />}
    </>
  )
}

/**
 * The down chevron on a button that opens a list: thin and shallow, like the
 * one the system draws. Native pop-up buttons are given this same shape in
 * `controls.css`, so the two cannot drift apart.
 */
export function Caret(): React.JSX.Element {
  return (
    <svg className="caret" viewBox="0 0 12 12" width="12" height="12" aria-hidden>
      <path d="M2 4.25 6 8l4-3.75" fill="none" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
