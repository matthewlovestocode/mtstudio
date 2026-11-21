import { useEffect, useRef, useState } from 'react'
import { acceleratorLabel, type MenuCommand, type MenuSection } from '@shared/menu'
import type { Id } from '@shared/model'
import { engine } from '../engine'
import { useStudio } from '../state/store'
import { useFrame } from '../util'

/** Peak meter with a fast attack and slow fall. */
export function Meter({ target }: { target: Id | 'master' }): React.JSX.Element {
  const fill = useRef<HTMLDivElement>(null)
  const shown = useRef(0)
  useFrame(() => {
    const peak = engine.getPeak(target)
    // Map -48 dB…0 dB onto 0…1.
    const level = peak > 0 ? Math.min(1, Math.max(0, (20 * Math.log10(peak) + 48) / 48)) : 0
    shown.current = Math.max(level, shown.current - 0.025)
    if (fill.current) fill.current.style.transform = `scaleX(${shown.current})`
  })
  return (
    <div className="meter">
      <div className="meter-fill" ref={fill} />
    </div>
  )
}

/** A number input that commits on Enter or blur rather than on every keystroke. */
export function NumberField(props: {
  value: number
  onCommit: (value: number) => void
  className?: string
  label: string
}): React.JSX.Element {
  const [text, setText] = useState(String(props.value))
  useEffect(() => setText(String(props.value)), [props.value])
  const commit = (): void => {
    const parsed = Number(text)
    if (Number.isFinite(parsed) && text.trim() !== '') props.onCommit(parsed)
    else setText(String(props.value))
  }
  return (
    <input
      className={props.className}
      aria-label={props.label}
      inputMode="decimal"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

/** A range input whose drag is a single undo step. */
export function Slider(props: {
  value: number
  min: number
  max: number
  step: number
  label: string
  className?: string
  /** Value restored on double-click. */
  reset?: number
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <input
      type="range"
      className={props.className}
      aria-label={props.label}
      title={props.label}
      min={props.min}
      max={props.max}
      step={props.step}
      value={props.value}
      onChange={(e) => props.onChange(Number(e.target.value))}
      onPointerUp={() => useStudio.getState().endGesture()}
      onKeyUp={() => useStudio.getState().endGesture()}
      onDoubleClick={() => props.reset !== undefined && props.onChange(props.reset)}
    />
  )
}

/** A text input that commits on Enter or blur, and snaps back if the commit is not accepted. */
export function TextField(props: {
  value: string
  onCommit: (value: string) => void
  className?: string
  label: string
}): React.JSX.Element {
  const [text, setText] = useState(props.value)
  useEffect(() => setText(props.value), [props.value])
  return (
    <input
      className={props.className}
      aria-label={props.label}
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        if (text !== props.value) props.onCommit(text)
        setText(props.value)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

const IS_MAC = navigator.platform.startsWith('Mac')

/**
 * A button that opens a small menu of commands under itself. Closes when a
 * command is chosen, on Escape, or on a click anywhere else.
 */
export function MenuButton(props: {
  label: string
  title: string
  sections: MenuSection[]
  /** Show each command's keyboard shortcut beside it. */
  shortcuts: boolean
  onCommand: (command: MenuCommand) => void
}): React.JSX.Element {
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!place) return
    const close = (): void => setPlace(null)
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node
      if (!panel.current?.contains(target) && !button.current?.contains(target)) close()
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      close()
      button.current?.focus()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('resize', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('resize', close)
      window.removeEventListener('blur', close)
    }
  }, [place])

  const toggle = (): void => {
    if (place) return setPlace(null)
    const box = button.current!.getBoundingClientRect()
    // Kept inside the window, whichever end of the bar the button is at.
    setPlace({ left: Math.max(8, Math.min(box.left, window.innerWidth - 248)), top: box.bottom + 4 })
  }

  return (
    <>
      <button ref={button} className={place ? 'menu-button open' : 'menu-button'} title={props.title} aria-haspopup="menu" aria-expanded={!!place} onClick={toggle}>
        {props.label}
      </button>
      {place && (
        <div className="menu-panel" role="menu" style={place} ref={panel}>
          {props.sections.map((section, index) => (
            <div key={section.label} role="group" aria-label={section.label}>
              {props.sections.length > 1 && <div className={index ? 'menu-heading divided' : 'menu-heading'}>{section.label}</div>}
              {section.items.map((item, i) =>
                item ? (
                  <button
                    key={item.command}
                    role="menuitem"
                    className="menu-item"
                    onClick={() => {
                      setPlace(null)
                      props.onCommand(item.command)
                    }}
                  >
                    <span>{item.label}</span>
                    {props.shortcuts && <span className="menu-shortcut">{acceleratorLabel(item.accelerator, IS_MAC)}</span>}
                  </button>
                ) : (
                  <div key={i} className="menu-separator" />
                )
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
